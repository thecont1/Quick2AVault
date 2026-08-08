// The reconnect path: a dead daemon must not leave the UI frozen forever.
//
// Reproduces the exact sequence the user hit — daemon down, period changed,
// daemon back — against the real VaultApi with a scripted transport, so the
// assertion is about behaviour rather than about a widget tree.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quick2avault_desktop/api.dart';

class _Down implements Exception {
  @override
  String toString() => 'SocketException: connection refused';
}

String _snapBody(int spendMinor, String label) => jsonEncode({
      'spending_minor': spendMinor,
      'income_minor': 0,
      'transfers_minor': 0,
      'counts': {
        'documents': 71, 'transactions': 38, 'entities': 81, 'evidence_links': 79,
      },
      'period': {'key': label, 'label': label},
    });

void main() {
  test('health() is false while down and true once the daemon returns',
      () async {
    var alive = false;
    final api = VaultApi(
      baseUrl: 'http://x',
      token: 't',
      client: MockClient((req) async {
        if (!alive) throw _Down();
        return http.Response('{"ok":true}', 200);
      }),
    );

    // While the daemon is down the reconnect loop needs `false`, not an
    // exception — an unhandled throw here would kill the retry timer and the
    // app would never come back without a restart.
    expect(await api.health(), isFalse);

    alive = true;
    expect(await api.health(), isTrue);
  });

  test('the period survives an outage and is used on the retry', () async {
    // The bug: _period was updated locally, the fetch failed, and nothing ever
    // re-issued it. On recovery the app must request the period the user
    // actually selected, not the one it was showing before the outage.
    var alive = false;
    final requested = <String>[];
    final api = VaultApi(
      baseUrl: 'http://x',
      token: 't',
      client: MockClient((req) async {
        requested.add(req.url.query);
        if (!alive) throw _Down();
        final aug = req.url.query.contains('2026-08');
        return http.Response(
          _snapBody(aug ? 838755 : 1789990, aug ? 'August 2026' : 'July 2026'),
          200,
        );
      }),
    );

    // User selects August while the daemon is down.
    await expectLater(
      api.snapshot(period: 'month', month: '2026-08'),
      throwsA(anything),
    );
    expect(requested.single, contains('month=2026-08'));

    // Daemon returns; the same period is re-requested and now succeeds.
    alive = true;
    final s = await api.snapshot(period: 'month', month: '2026-08');
    expect(requested.last, contains('month=2026-08'));
    expect(s.spendingMinor, 838755);
    expect(s.period.label, 'August 2026',
        reason: 'the recovered figures must describe the SELECTED period');
  });

  test('a failed fetch never yields a zero snapshot', () async {
    // Zero is a legitimate value. An outage must not be able to produce one,
    // or an empty vault and a dead daemon look identical.
    final api = VaultApi(
      baseUrl: 'http://x',
      token: 't',
      client: MockClient((_) async => throw _Down()),
    );
    await expectLater(api.snapshot(period: 'all'), throwsA(anything));
  });
}
