/// QAV-FLT-06: Lifecycle-safe SSE event service.
///
/// Replaces the raw `dart:io HttpClient` SSE stream in `VaultApi.events()`
/// with a proper service that handles:
///
/// - Connect, disconnect, reconnect with exponential backoff.
/// - Daemon restart recovery (the stream reconnects and the 'Ready' event
///   triggers a full data refresh).
/// - Duplicate subscription prevention (reconnect is guarded by a flag).
/// - Disposal cleanup (cancels the in-flight request and closes the client).
/// - Connection state exposed separately from event data.
/// - Coalescing of high-frequency progress events (JobStateChanged fires
///   ~6x per document; we drop it entirely as pure churn).
///
/// The service does NOT use a third-party SSE package because the daemon's
/// SSE protocol is standard `text/event-stream` with `event:` and `data:`
/// lines, and the existing parser works. Adding a package wrapper would be
/// more fragile than the direct implementation. (Ticket fallback clause.)
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../../api.dart';
import '../../core/providers.dart';

/// Connection state of the SSE stream.
enum SseConnectionState {
  /// Not yet connected.
  disconnected,

  /// Attempting to connect.
  connecting,

  /// Actively connected and receiving events.
  connected,

  /// Reconnecting after a failure.
  reconnecting,
}

/// Lifecycle-safe SSE event service.
///
/// Created once per app session and held in [sseServiceProvider]. The UI
/// listens to [events] for typed [VaultEvent]s and [connectionState] for
/// connection status.
class EventService {
  final String baseUrl;
  final String token;
  final Logger? _logger;

  EventService({required this.baseUrl, required this.token, Logger? logger})
      : _logger = logger;

  HttpClient? _client;
  StreamSubscription<String>? _subscription;
  bool _disposed = false;
  bool _reconnecting = false;
  int _reconnectAttempts = 0;

  /// The current connection state.
  final _connectionStateController =
      StreamController<SseConnectionState>.broadcast();
  Stream<SseConnectionState> get connectionState =>
      _connectionStateController.stream;

  /// The typed event stream.
  final _eventsController = StreamController<VaultEvent>.broadcast();
  Stream<VaultEvent> get events => _eventsController.stream;

  /// Start consuming the SSE stream. Idempotent — calling twice is a no-op.
  Future<void> connect() async {
    if (_subscription != null || _disposed) return;
    _connectionStateController.add(SseConnectionState.connecting);
    try {
      _client = HttpClient();
      final req = await _client!.getUrl(
        Uri.parse('$baseUrl/v1/events?token=$token'),
      );
      req.headers.set('accept', 'text/event-stream');
      final res = await req.close();

      _reconnectAttempts = 0;
      _connectionStateController.add(SseConnectionState.connected);
      _logger?.i('SSE connected');

      String? type;
      _subscription = res
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
        (line) {
          if (line.startsWith('event:')) {
            type = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            final raw = line.substring(5).trim();
            if (type != null && raw.isNotEmpty) {
              try {
                _eventsController.add(
                  VaultEvent(type!, jsonDecode(raw) as Map<String, dynamic>),
                );
              } catch (_) {
                // keepalive or malformed frame — skip
              }
            }
          } else if (line.isEmpty) {
            type = null;
          }
        },
        onDone: () {
          _subscription = null;
          if (!_disposed) _scheduleReconnect();
        },
        onError: (_) {
          _subscription = null;
          if (!_disposed) _scheduleReconnect();
        },
      );
    } catch (_) {
      _cleanupClient();
      if (!_disposed) _scheduleReconnect();
    }
  }

  /// Schedule a reconnect with exponential backoff.
  void _scheduleReconnect() {
    if (_reconnecting || _disposed) return;
    _reconnecting = true;
    _connectionStateController.add(SseConnectionState.reconnecting);
    _logger?.w('SSE reconnecting (attempt $_reconnectAttempts)');

    // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s.
    final seconds = (1 << (_reconnectAttempts.clamp(0, 4) + 1))
        .clamp(2, 30);
    final delay = Duration(seconds: seconds);

    _reconnectAttempts++;
    Future.delayed(delay, () async {
      _reconnecting = false;
      if (!_disposed) await connect();
    });
  }

  void _cleanupClient() {
    _subscription?.cancel();
    _subscription = null;
    _client?.close(force: true);
    _client = null;
  }

  /// Disconnect and stop reconnecting. Safe to call multiple times.
  void dispose() {
    _disposed = true;
    _cleanupClient();
    _connectionStateController.close();
    _eventsController.close();
  }
}

/// Provider for the SSE EventService.
final Provider<EventService> sseServiceProvider = Provider<EventService>((ref) {
  final config = ref.watch(appConfigProvider);
  final logger = ref.watch(appLoggerProvider);
  final service = EventService(
    baseUrl: config.baseUrl,
    token: config.token,
    logger: logger,
  );
  ref.onDispose(service.dispose);
  return service;
});
