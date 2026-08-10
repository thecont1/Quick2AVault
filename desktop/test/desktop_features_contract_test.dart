import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/intake/view.dart';
import 'package:quick2avault_desktop/features/people/view.dart';
import 'package:quick2avault_desktop/features/review/document_detail.dart';

Widget _host(Widget child, {double width = 900}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(width: width, child: child),
  ),
);

void main() {
  testWidgets(
    'Intake keeps terminal pipeline states and source mapping visible',
    (tester) async {
      await tester.pumpWidget(
        _host(
          IntakeView(
            items: [
              IntakeItem(
                id: 'one',
                filename: 'locked-contract-note.pdf',
                entity: 'Paytm Money',
                entityKind: EntityKind.organisation,
                state: PipelineState.passwordNeeded,
                source: 'Drop folder · still in source',
                date: DateTime(2026, 7, 1),
              ),
              IntakeItem(
                id: 'two',
                filename: 'copy-invoice.pdf',
                entity: 'PetaSight',
                entityKind: EntityKind.organisation,
                state: PipelineState.duplicate,
                source: 'Archive · duplicate retained',
                date: DateTime(2026, 7, 2),
              ),
            ],
          ),
        ),
      );

      expect(find.text('2 arrivals'), findsOneWidget);
      expect(find.text('Password needed'), findsWidgets);
      expect(find.text('Duplicate'), findsWidgets);
      expect(find.textContaining('still in source'), findsOneWidget);
      expect(find.text('PAYTM MONEY'), findsOneWidget);
    },
  );

  testWidgets('People preserves kinds and scopes merge actions', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        EntityDesk(
          entities: const [
            EntitySummary(
              id: 'p1',
              name: 'Mahesh Shantaram',
              kind: EntityKind.person,
            ),
            EntitySummary(
              id: 'o1',
              name: 'PetaSight Inc.',
              kind: EntityKind.organisation,
            ),
            EntitySummary(
              id: 'a1',
              name: 'HDFC Current',
              kind: EntityKind.account,
              last4: '5675',
            ),
          ],
        ),
      ),
    );

    expect(find.text('person'), findsOneWidget);
    expect(find.text('organisation'), findsOneWidget);
    expect(find.text('account · ••••5675'), findsOneWidget);
    await tester.tap(find.text('PetaSight Inc.'));
    await tester.pump();
    expect(find.text('Merge only with organisations'), findsOneWidget);
    expect(find.textContaining('never merge across kinds'), findsOneWidget);
  });

  testWidgets(
    'Glaze document detail composes impact, fields, parties and audit',
    (tester) async {
      await tester.pumpWidget(
        _host(
          DocumentDetailPanel(
            document: DetailDocument.invoice(
              filename:
                  'a-very-long-petasight-tax-invoice-file-name-that-must-not-overflow.pdf',
              amount: '₹57,025.62',
              lines: const [
                DetailLine(
                  'Data Science consulting services',
                  '998393',
                  '0.3043',
                  r'$5,397',
                  r'$1,642.31',
                ),
              ],
            ),
          ),
          width: 360,
        ),
      );

      expect(find.text('Document'), findsOneWidget);
      expect(find.text('Markdown'), findsOneWidget);
      expect(find.text('Financial impact'), findsOneWidget);
      expect(find.text('Income of ₹57,025.62.'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Line items'),
        150,
        scrollable: find.byType(Scrollable).last,
      );
      expect(find.text('Line items'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Fields & evidence'),
        250,
        scrollable: find.byType(Scrollable).last,
      );
      expect(find.text('Fields & evidence'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Parties'),
        250,
        scrollable: find.byType(Scrollable).last,
      );
      expect(find.text('Parties'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Identity reasoning'),
        250,
        scrollable: find.byType(Scrollable).last,
      );
      expect(find.text('Identity reasoning'), findsOneWidget);
      expect(find.text('Audit trail (3)'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Delete permanently'),
        250,
        scrollable: find.byType(Scrollable).last,
      );
      expect(find.text('Delete permanently'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
