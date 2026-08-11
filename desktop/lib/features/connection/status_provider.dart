/// QAV-FLT-05: Daemon connection status.
///
/// The first feature migrated to Riverpod. Replaces the `_daemonUp` /
/// `_connected` / `_stale` / `_authError` fields held in the `_VaultHomeState`
/// god widget with a single observable state object.
///
/// The notifier polls the daemon health endpoint and exposes a typed
/// [ConnectionStatus] that the UI can switch on: loading, connected,
/// degraded (stale), authError, or unreachable.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';

/// The daemon's reachability and auth state, as the client knows it.
///
/// - [ConnectionStatus.loading]: initial state, before the first health check.
/// - [ConnectionStatus.connected]: the daemon answered and the token is valid.
/// - [ConnectionStatus.degraded]: the last data fetch failed but the daemon
///   was previously reachable; the figures on screen are stale.
/// - [ConnectionStatus.authError]: the daemon rejected the token. The numbers
///   on screen are meaningless and must not be presented as the vault's state.
/// - [ConnectionStatus.unreachable]: the daemon is not responding.
sealed class ConnectionStatus {
  const ConnectionStatus();

  /// True when the daemon is reachable and the token is valid.
  bool get isConnected => false;

  /// True when the last fetch failed but the daemon was previously up.
  bool get isDegraded => false;

  /// True when the daemon rejected the token.
  bool get isAuthError => false;

  /// True when the daemon is not responding at all.
  bool get isUnreachable => false;

  /// A user-facing banner message, or null when the connection is healthy.
  String? get banner => null;
}

class _Loading extends ConnectionStatus {
  const _Loading();
}

class _Connected extends ConnectionStatus {
  const _Connected();
  @override
  bool get isConnected => true;
}

class _Degraded extends ConnectionStatus {
  const _Degraded(this._periodLabel);
  final String _periodLabel;

  @override
  bool get isDegraded => true;

  @override
  String? get banner =>
      'Daemon unreachable — showing the last figures fetched, '
      'not $_periodLabel.';
}

class _AuthError extends ConnectionStatus {
  const _AuthError();
  @override
  bool get isAuthError => true;
  @override
  String? get banner =>
      'Cannot read the vault — the daemon rejected this '
      'app\'s token. Your data is intact; the totals below are not real.';
}

class _Unreachable extends ConnectionStatus {
  const _Unreachable();
  @override
  bool get isUnreachable => true;
}

/// Notifier that polls the daemon and tracks connection state.
class ConnectionNotifier extends Notifier<ConnectionStatus> {
  Timer? _pollTimer;
  bool _wasConnected = false;

  @override
  ConnectionStatus build() {
    ref.onDispose(() => _pollTimer?.cancel());
    return const _Loading();
  }

  /// Start polling for daemon health. Called by the UI after mount.
  void start() => check();

  /// Check the daemon's health and update state.
  Future<void> check() async {
    final api = ref.read(vaultApiProvider);
    try {
      final healthy = await api.health();
      if (healthy) {
        _wasConnected = true;
        state = const _Connected();
      } else {
        state = _wasConnected
            ? const _Degraded('the selected period')
            : const _Unreachable();
        _schedulePoll();
      }
    } catch (_) {
      state = _wasConnected
          ? const _Degraded('the selected period')
          : const _Unreachable();
      _schedulePoll();
    }
  }

  /// Mark the connection as degraded after a failed data fetch.
  void markDegraded(String periodLabel) {
    if (state is _Connected || state is _Loading) {
      state = _Degraded(periodLabel);
      _schedulePoll();
    }
  }

  /// Mark the connection as having an auth error.
  void markAuthError() {
    state = const _AuthError();
  }

  /// Mark the connection as healthy after a successful data fetch.
  void markConnected() {
    _wasConnected = true;
    state = const _Connected();
  }

  void _schedulePoll() {
    _pollTimer?.cancel();
    _pollTimer = Timer(const Duration(seconds: 2), check);
  }
}

/// The daemon connection status.
final NotifierProvider<ConnectionNotifier, ConnectionStatus>
connectionStatusProvider =
    NotifierProvider<ConnectionNotifier, ConnectionStatus>(
      ConnectionNotifier.new,
    );
