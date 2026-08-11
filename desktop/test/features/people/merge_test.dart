// WO11 A2 — same-kind merge on the People desk.
//
// The picker is filtered by kind AND confirmation state, identical display
// names are disambiguated by email/last-4, and the write requires a second
// confirmation that states the predicted rule.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/people/view.dart';

Widget _host(
  List<EntitySummary> entities, {
  void Function(EntitySummary, EntitySummary)? onMerge,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 900,
      child: EntityDesk(entities: entities, onMerge: onMerge),
    ),
  ),
);

void main() {
  testWidgets('the picker lists same-kind confirmed entities only', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const [
          EntitySummary(id: 'p1', name: 'A Kamath', kind: EntityKind.person),
          EntitySummary(id: 'p2', name: 'Arun Kamath', kind: EntityKind.person),
          EntitySummary(
            id: 'p3',
            name: 'Unconfirmed Priya',
            kind: EntityKind.person,
            confirmed: false,
          ),
          EntitySummary(
            id: 'o1',
            name: 'Kamath Industries',
            kind: EntityKind.organisation,
          ),
        ],
        onMerge: (_, _) {},
      ),
    );
    await tester.tap(find.text('A Kamath'));
    await tester.pump();
    await tester.tap(find.text('Merge with…'));
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byType(SimpleDialog),
        matching: find.text('Arun Kamath'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(SimpleDialog),
        matching: find.text('Unconfirmed Priya'),
      ),
      findsNothing,
      reason: 'you merge into a confirmed entity, not a candidate',
    );
    expect(
      find.descendant(
        of: find.byType(SimpleDialog),
        matching: find.text('Kamath Industries'),
      ),
      findsNothing,
      reason: 'the picker never crosses kinds',
    );
  });

  testWidgets('identical display names are disambiguated by email', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const [
          EntitySummary(id: 'p1', name: 'Priya Nair', kind: EntityKind.person),
          EntitySummary(
            id: 'p2',
            name: 'Priya Nair',
            kind: EntityKind.person,
            email: 'priya@work.example',
          ),
          EntitySummary(
            id: 'p3',
            name: 'Priya Nair',
            kind: EntityKind.person,
            email: 'priya@home.example',
          ),
        ],
        onMerge: (_, _) {},
      ),
    );
    await tester.tap(find.text('Priya Nair').first);
    await tester.pump();
    await tester.tap(find.text('Merge with…'));
    await tester.pumpAndSettle();

    expect(find.text('priya@work.example'), findsOneWidget);
    expect(find.text('priya@home.example'), findsOneWidget);
  });

  testWidgets('merge requires the confirmation dialog and states the rule', (
    tester,
  ) async {
    (String, String)? called;
    await tester.pumpWidget(
      _host(
        const [
          EntitySummary(id: 'p1', name: 'A Kamath', kind: EntityKind.person),
          EntitySummary(id: 'p2', name: 'Arun Kamath', kind: EntityKind.person),
        ],
        onMerge: (source, target) => called = (source.id, target.id),
      ),
    );
    await tester.tap(find.text('A Kamath'));
    await tester.pump();
    await tester.tap(find.text('Merge with…'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(SimpleDialog),
        matching: find.text('Arun Kamath'),
      ),
    );
    await tester.pumpAndSettle();

    // The predicted rule, stated before the write.
    expect(
      find.textContaining('"A Kamath" becomes a confirmed alias of Arun Kamath'),
      findsOneWidget,
    );
    expect(find.textContaining('cannot be undone'), findsOneWidget);
    expect(called, isNull, reason: 'no write before the second confirmation');

    await tester.tap(find.widgetWithText(FilledButton, 'Merge'));
    await tester.pumpAndSettle();
    expect(called, ('p1', 'p2'));
  });

  testWidgets('no merge affordance for candidates or lone entities', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const [
          EntitySummary(
            id: 'c1',
            name: 'Maybe Priya',
            kind: EntityKind.person,
            confirmed: false,
          ),
          EntitySummary(id: 'o1', name: 'Lone Org', kind: EntityKind.organisation),
        ],
        onMerge: (_, _) {},
      ),
    );
    await tester.tap(find.text('Maybe Priya'));
    await tester.pump();
    expect(find.text('Merge with…'), findsNothing);
    await tester.tap(find.text('Lone Org'));
    await tester.pump();
    expect(find.text('Merge with…'), findsNothing);
  });
}
