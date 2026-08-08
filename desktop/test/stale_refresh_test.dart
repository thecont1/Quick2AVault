// A failed refresh must never leave stale figures looking authoritative.
//
// The bug you hit twice: click Month/Year, the button highlights (because
// _period changed locally), the fetch throws because the daemon is down, and
// `catch (_) {}` swallows it. The old figures stay on screen under the new
// selection, so the picker looks broken when the real problem is that nothing
// is listening on 4479.
//
// The first time this presented as "the period buttons do nothing" it was a
// genuinely different bug (the endpoint ignored the period). That fix was
// real, but it left this second failure mode with identical symptoms — which
// is why the regression came back looking the same.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/popup_view.dart';
import 'package:quick2avault_desktop/widgets/period_bar.dart';

Snapshot _snap(int spendMinor, String label) => Snapshot(
      spendingMinor: spendMinor,
      incomeMinor: 0,
      transfersMinor: 0,
      documents: 71,
      transactions: 38,
      entities: 81,
      evidenceLinks: 79,
      period: Period(key: label, label: label),
    );

Widget _popup({String? authError, required Snapshot snapshot}) => MaterialApp(
      home: SizedBox(
        width: 420,
        height: 620,
        child: PopupView(
          snapshot: snapshot,
          authError: authError,
          periods: Periods.empty,
          selection: PeriodSelection.thisMonth,
          onPeriodChanged: (_) {},
          txns: const [],
          feed: const [],
          connected: false,
          onOpenFull: () {},
          onQuit: () {},
          onSetup: () {},
          onReview: () {},
          onRefresh: () {},
          onToggleLearning: () {},
        ),
      ),
    );

void main() {
  testWidgets('a stale banner is shown when figures are frozen', (tester) async {
    await tester.pumpWidget(_popup(
      snapshot: _snap(1789990, 'July 2026'),
      authError: 'Daemon unreachable — showing the last figures fetched, '
          'not 2026-08.',
    ));
    await tester.pumpAndSettle();

    // The user must be told the number does not describe their selection.
    expect(find.textContaining('Daemon unreachable'), findsOneWidget);
    expect(find.textContaining('not 2026-08'), findsOneWidget);
  });

  testWidgets('no banner when the fetch succeeded', (tester) async {
    await tester.pumpWidget(_popup(snapshot: _snap(838755, 'August 2026')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Daemon unreachable'), findsNothing);
  });

  test('a transport failure throws rather than returning empty data', () async {
    // The client must not translate a dead socket into a valid-looking zero
    // snapshot; that is what made an outage indistinguishable from an empty
    // vault.
    final api = VaultApi(
      baseUrl: 'http://127.0.0.1:9',
      token: 't',
      client: MockClient((_) async => throw const SocketException_('refused')),
    );
    await expectLater(
      api.snapshot(period: 'month', month: '2026-08'),
      throwsA(isA<Exception>()),
    );
  });

  test('health() reports false when the daemon is unreachable', () async {
    final api = VaultApi(
      baseUrl: 'http://127.0.0.1:9',
      token: 't',
      client: MockClient((_) async => throw const SocketException_('refused')),
    );
    expect(await api.health(), isFalse,
        reason: 'the reconnect loop depends on this returning false, not throwing');
  });

  test('a 200 with a different period yields different figures', () async {
    // Guards the ORIGINAL bug: the endpoint must vary with the period.
    var lastQuery = '';
    final api = VaultApi(
      baseUrl: 'http://x',
      token: 't',
      client: MockClient((req) async {
        lastQuery = req.url.query;
        final spend = req.url.query.contains('2026-07') ? 1789990 : 838755;
        return http.Response(
          jsonEncode({
            'spending_minor': spend,
            'income_minor': 0,
            'transfers_minor': 0,
            'counts': {
              'documents': 1, 'transactions': 1, 'entities': 1, 'evidence_links': 1,
            },
            'period': {'key': 'x', 'label': 'x'},
          }),
          200,
        );
      }),
    );

    final jul = await api.snapshot(period: 'month', month: '2026-07');
    expect(lastQuery, contains('month=2026-07'));
    final aug = await api.snapshot(period: 'month', month: '2026-08');
    expect(lastQuery, contains('month=2026-08'));

    expect(jul.spendingMinor, isNot(aug.spendingMinor),
        reason: 'the period must reach the wire, or the picker is decorative');
  });
}

/// Minimal stand-in so the test does not depend on dart:io in a widget test.
class SocketException_ implements Exception {
  final String message;
  const SocketException_(this.message);
  @override
  String toString() => 'SocketException: $message';
}
