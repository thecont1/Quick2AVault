// Evidence must open INLINE — directly beneath the transaction that was
// clicked, not appended after the whole list.
//
// The bug this guards against: with the panel rendered after the list, a user
// clicking row 2 of 40 had to scroll to the bottom to see the proof, which
// severs the link between a claim and its evidence.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/evidence_panel.dart';
import 'package:quick2avault_desktop/widgets/txn_card.dart';

Txn _txn(String id, String who, int minor) => Txn(
      id: id,
      occurredAt: '2026-08-06',
      fyKey: 'FY 2026-27',
      amountMinor: minor,
      direction: 'out',
      counterparty: who,
    );

EvidenceCard _card(Txn t) => EvidenceCard(
      transaction: t,
      legs: const [],
      evidence: const [],
      provenance: const [],
      summary: 'one document, one rupee',
    );

/// Mirrors the production list: each row is a Column of [card, panel?].
Widget _list(List<Txn> txns, String? selectedId, EvidenceCard? card) {
  return MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: Column(
          children: [
            for (final t in txns)
              Column(
                key: ValueKey('row-${t.id}'),
                children: [
                  TxnCard(txn: t, selected: selectedId == t.id, onTap: () {}),
                  if (selectedId == t.id && card != null)
                    EvidencePanel(card: card),
                ],
              ),
          ],
        ),
      ),
    ),
  );
}

void main() {
  final txns = [
    _txn('t1', 'First Merchant', 10000),
    _txn('t2', 'Second Merchant', 20000),
    _txn('t3', 'Third Merchant', 30000),
  ];

  testWidgets('no evidence panel when nothing is selected', (tester) async {
    await tester.pumpWidget(_list(txns, null, null));
    expect(find.byType(EvidencePanel), findsNothing);
  });

  testWidgets('evidence renders inside the selected row, not after the list',
      (tester) async {
    await tester.pumpWidget(_list(txns, 't2', _card(txns[1])));

    expect(find.byType(EvidencePanel), findsOneWidget);

    // The panel must be a DESCENDANT of row t2 — that is what "immediately
    // below it" means structurally, and it cannot be faked by ordering.
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('row-t2')),
        matching: find.byType(EvidencePanel),
      ),
      findsOneWidget,
      reason: 'evidence panel is not inside the clicked transaction row',
    );

    // And it must NOT belong to any other row.
    for (final id in ['t1', 't3']) {
      expect(
        find.descendant(
          of: find.byKey(ValueKey('row-$id')),
          matching: find.byType(EvidencePanel),
        ),
        findsNothing,
        reason: 'evidence leaked into row $id',
      );
    }
  });

  testWidgets('panel sits vertically between the clicked row and the next one',
      (tester) async {
    await tester.pumpWidget(_list(txns, 't2', _card(txns[1])));

    final panelY = tester.getTopLeft(find.byType(EvidencePanel)).dy;
    final selectedCardY =
        tester.getTopLeft(find.byKey(const ValueKey('row-t2'))).dy;
    final nextRowY = tester.getTopLeft(find.byKey(const ValueKey('row-t3'))).dy;

    expect(panelY, greaterThan(selectedCardY),
        reason: 'panel must be below the card it belongs to');
    expect(panelY, lessThan(nextRowY),
        reason: 'panel must appear BEFORE the next transaction, not at the end');
  });
}
