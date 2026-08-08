// The hero note must state the period the data is actually from.
//
// The bug: Spending was labelled "this financial year" as a hardcoded string
// while the viewer was showing July 2026 figures (Rs 17,899.90 against an FY
// total of Rs 40,583.37). A number under a wrong label reads as a wrong
// number — the most damaging kind of UI bug in a ledger.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/hero_row.dart';

Snapshot _snap(Period p) => Snapshot(
      spendingMinor: 1789990,
      incomeMinor: 0,
      transfersMinor: 0,
      documents: 71,
      transactions: 38,
      entities: 81,
      evidenceLinks: 79,
      period: p,
    );

Future<void> _pump(WidgetTester tester, Snapshot s) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: SizedBox(width: 1200, child: HeroRow(snapshot: s, txns: const [])),
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a month period says the month, not "this financial year"',
      (tester) async {
    await _pump(tester, _snap(const Period(key: '2026-07', label: 'July 2026')));
    expect(find.text('july 2026'), findsOneWidget);
    expect(find.text('this financial year'), findsNothing,
        reason: 'the label must follow the data, not a hardcoded assumption');
  });

  testWidgets('an FY period says the FY', (tester) async {
    await _pump(tester, _snap(const Period(key: 'FY 2026-27', label: 'FY 2026-27')));
    expect(find.text('fy 2026-27'), findsOneWidget);
  });

  testWidgets('an unlabelled period falls back to "all time"', (tester) async {
    await _pump(tester, _snap(const Period(key: 'all', label: '')));
    expect(find.text('all time'), findsOneWidget);
  });
}
