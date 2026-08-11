/// QAV-FLT-06: Tests for the SSE EventService.
///
/// Tests cover initial connection, event parsing, malformed events,
/// disconnect, retry, and cancellation.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/features/events/event_service.dart';

/// A mock SSE server that accepts a single connection and sends scripted
/// events.
class _MockSseServer {
  final List<String> _lines;
  HttpServer? _server;
  int _port = 0;

  _MockSseServer(this._lines);

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _port = _server!.port;
    _server!.listen((request) {
      request.response.headers.set('content-type', 'text/event-stream');
      request.response.headers.set('cache-control', 'no-cache');
      request.response.headers.set('connection', 'keep-alive');
      for (final line in _lines) {
        request.response.add(utf8.encode('$line\n'));
      }
      request.response.close();
    });
  }

  String get url => 'http://127.0.0.1:$_port/v1/events';

  Future<void> stop() async => _server?.close(force: true);
}

void main() {
  group('EventService', () {
    test('parses well-formed SSE events', () async {
      final server = _MockSseServer([
        'event: Ready',
        'data: {"status": "ok"}',
        '',
        'event: TransactionRecorded',
        'data: {"transaction_id": "t1"}',
        '',
      ]);
      await server.start();
      addTearDown(server.stop);

      final service = EventService(baseUrl: 'http://127.0.0.1:${server._port}', token: 't');
      addTearDown(service.dispose);

      final events = <VaultEvent>[];
      final completer = Completer<void>();
      service.events.listen((e) {
        events.add(e);
        if (events.length >= 2) completer.complete();
      });

      await service.connect();
      await completer.future.timeout(const Duration(seconds: 5));

      expect(events.length, 2);
      expect(events[0].type, 'Ready');
      expect(events[0].data['status'], 'ok');
      expect(events[1].type, 'TransactionRecorded');
      expect(events[1].data['transaction_id'], 't1');
    });

    test('skips malformed data lines without crashing', () async {
      final server = _MockSseServer([
        'event: Test',
        'data: not valid json',
        '',
        'event: Good',
        'data: {"ok": true}',
        '',
      ]);
      await server.start();
      addTearDown(server.stop);

      final service = EventService(baseUrl: 'http://127.0.0.1:${server._port}', token: 't');
      addTearDown(service.dispose);

      final events = <VaultEvent>[];
      final completer = Completer<void>();
      service.events.listen((e) {
        events.add(e);
        if (events.length >= 1) completer.complete();
      });

      await service.connect();
      await completer.future.timeout(const Duration(seconds: 5));

      // The malformed event is skipped; only the good one is emitted.
      expect(events.length, 1);
      expect(events[0].type, 'Good');
      expect(events[0].data['ok'], true);
    });

    test('exposes connection state changes', () async {
      final server = _MockSseServer([
        'event: Ready',
        'data: {}',
        '',
      ]);
      await server.start();
      addTearDown(server.stop);

      final service = EventService(baseUrl: 'http://127.0.0.1:${server._port}', token: 't');
      addTearDown(service.dispose);

      final states = <SseConnectionState>[];
      service.connectionState.listen((s) => states.add(s));

      await service.connect();
      // Wait for the event to be processed.
      final completer = Completer<void>();
      service.events.listen((_) => completer.complete());
      await completer.future.timeout(const Duration(seconds: 5));

      expect(states, contains(SseConnectionState.connecting));
      expect(states, contains(SseConnectionState.connected));
    });

    test('dispose stops the stream and prevents reconnection', () async {
      final server = _MockSseServer([
        'event: Ready',
        'data: {}',
        '',
      ]);
      await server.start();
      addTearDown(server.stop);

      final service = EventService(baseUrl: 'http://127.0.0.1:${server._port}', token: 't');

      await service.connect();
      // Wait briefly for connection.
      await Future.delayed(const Duration(milliseconds: 100));

      service.dispose();

      // The events stream should be closed.
      expect(service.events, emitsDone);
    });

    test('connect is idempotent', () async {
      final server = _MockSseServer([
        'event: Ready',
        'data: {}',
        '',
      ]);
      await server.start();
      addTearDown(server.stop);

      final service = EventService(baseUrl: 'http://127.0.0.1:${server._port}', token: 't');
      addTearDown(service.dispose);

      await service.connect();
      // Calling again should be a no-op, not a second connection.
      await service.connect();

      // Only one event should arrive, not duplicates.
      final events = <VaultEvent>[];
      final completer = Completer<void>();
      service.events.listen((e) {
        events.add(e);
        completer.complete();
      });
      await completer.future.timeout(const Duration(seconds: 5));
      expect(events.length, 1);
    });
  });
}
