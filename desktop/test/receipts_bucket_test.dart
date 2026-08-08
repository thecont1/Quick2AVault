// Clicking a hero card shows the receipts that produced that figure.
//
// The property that matters: the list must sum to the figure it claims to
// explain. The daemon achieves this by reusing snapshot()'s predicates
// verbatim; these tests pin the CLIENT half — that the bucket reaches the
// wire, that the default is spending, and that the heading names the bucket
// rather than saying "Recent".
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/popup_view.dart';
import 'package:quick2avault_desktop/widgets/period_bar.dart';

Snapshot _snap() => const Snapshot(
      spendingMinor: 4058337,
      incomeMinor: 17290782,
      transfersMinor: 0,
      investmentsMinor: 53315794,
      documents: 71,
      transactions: 78,
      entities: 81,
      evidenceLinks: 79,
      period: Period(key: 'FY 2026-27', label: 'FY 2026-27'),
      incomeDocs: 5,
      spendingDocs: 50,
      investmentDocs: 16,
    );

Txn _txn(String id, int minor) => Txn(
      id: id,
      occurredAt: '2026-07-31',
      direction: 'out',
      amountMinor: minor,
      counterparty: 'Someone',
      status: 'evidenced',
      rail: 'upi',
      fyKey: 'FY 2026-27',
    );

Widget _popup({
  String bucket = 'spending',
  ValueChanged<String>? onBucketChanged,
  List<Txn> txns = const [],
}) =>
    MaterialApp(
      home: SizedBox(
        width: 420,
        height: 620,
        child: PopupView(
          snapshot: _snap(),
          periods: Periods.empty,
          selection: PeriodSelection.thisFy,
          onPeriodChanged: (_) {},
          txns: txns,
          feed: const [],
          connected: true,
          onOpenFull: () {},
          onQuit: () {},
          onSetup: () {},
          onReview: () {},
          onRefresh: () {},
          onToggleLearning: () {},
          bucket: bucket,
          onBucketChanged: onBucketChanged,
        ),
      ),
    );

void main() {
  testWidgets('the popup opens on Spending', (tester) async {
    // Default chosen deliberately: an unfiltered list answers no question, and
    // spending is the figure people actually interrogate.
    await tester.pumpWidget(_popup(txns: [_txn('t1', 100000)]));
    await tester.pumpAndSettle();
    expect(find.textContaining('SPENDING RECEIPTS'), findsOneWidget);
  });

  testWidgets('the heading names the bucket, not "Recent"', (tester) async {
    for (final (bucket, heading) in [
      ('income', 'INCOME RECEIPTS'),
      ('investments', 'INVESTMENT RECEIPTS'),
      ('spending', 'SPENDING RECEIPTS'),
    ]) {
      await tester.pumpWidget(_popup(bucket: bucket, txns: [_txn('t1', 1)]));
      await tester.pumpAndSettle();
      expect(find.textContaining(heading), findsOneWidget);
      expect(find.textContaining('RECENT'), findsNothing);
    }
  });

  testWidgets('tapping a card reports the bucket', (tester) async {
    final tapped = <String>[];
    await tester.pumpWidget(_popup(
      onBucketChanged: tapped.add,
      txns: [_txn('t1', 1)],
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Income'));
    await tester.tap(find.text('Investments'));
    await tester.pumpAndSettle();

    expect(tapped, ['income', 'investments']);
  });

  testWidgets('the selected card is marked for screen readers', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_popup(bucket: 'income', txns: [_txn('t1', 1)]));
    await tester.pumpAndSettle();

    // Match on the semantics LABEL rather than walking ancestors: the card is
    // wrapped in several Semantics nodes and .first picks an outer one.
    expect(
      find.bySemanticsLabel(RegExp(r'^Income,.*showing receipts')),
      findsOneWidget,
    );
    // And the unselected cards must not claim it.
    expect(
      find.bySemanticsLabel(RegExp(r'^Spending,.*showing receipts')),
      findsNothing,
    );
    handle.dispose();
  });

  test('the bucket reaches the wire', () async {
    // The whole feature is a query parameter; if it never leaves the client
    // the list silently shows everything and the totals stop matching.
    var lastQuery = '';
    final api = VaultApi(
      baseUrl: 'http://x',
      token: 't',
      client: MockClient((req) async {
        lastQuery = req.url.query;
        return http.Response(jsonEncode({'transactions': []}), 200);
      }),
    );

    await api.transactions(period: 'fy', fy: 'FY 2026-27', bucket: 'investments');
    expect(lastQuery, contains('bucket=investments'));
    expect(lastQuery, contains('fy=FY+2026-27'));

    // And omitting it must not send an empty bucket, which the daemon would
    // treat as an unknown filter rather than "no filter".
    await api.transactions(period: 'all');
    expect(lastQuery, isNot(contains('bucket')));
  });
}
