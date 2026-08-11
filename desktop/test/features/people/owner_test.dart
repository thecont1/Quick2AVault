// WO11 A1 — owner assignment on the People desk.
//
// The owner toggle is exclusive (the daemon unsets the previous owner in the
// same atomic write), person-only, and hidden for candidates. The desk shows
// a star badge on the owner row.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/people/view.dart';

const _priya = EntitySummary(
  id: 'p1',
  name: 'Priya Nair',
  kind: EntityKind.person,
  documents: 2,
);
const _mahesh = EntitySummary(
  id: 'p2',
  name: 'Mahesh Kamath',
  kind: EntityKind.person,
  owner: true,
  documents: 9,
);

Widget _host(
  List<EntitySummary> entities, {
  void Function(EntitySummary, bool)? onSetOwner,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 900,
      child: EntityDesk(entities: entities, onSetOwner: onSetOwner),
    ),
  ),
);

void main() {
  testWidgets('owner row carries the star badge', (tester) async {
    await tester.pumpWidget(_host(const [_priya, _mahesh]));
    expect(find.byIcon(Icons.star), findsOneWidget);
  });

  testWidgets('making a confirmed person owner asks first, then calls back', (
    tester,
  ) async {
    (String, bool)? called;
    await tester.pumpWidget(
      _host(
        const [_priya, _mahesh],
        onSetOwner: (entity, owner) => called = (entity.id, owner),
      ),
    );
    await tester.tap(find.text('Priya Nair'));
    await tester.pump();

    expect(find.text('Make owner'), findsOneWidget);
    await tester.tap(find.text('Make owner'));
    await tester.pumpAndSettle();

    // The confirmation dialog states the exclusivity up front.
    expect(find.textContaining('previous owner is unset'), findsOneWidget);
    expect(called, isNull, reason: 'no write before confirmation');
    await tester.tap(find.widgetWithText(FilledButton, 'Make owner'));
    await tester.pumpAndSettle();
    expect(called, ('p1', true));
  });

  testWidgets('the current owner gets an unset action instead', (
    tester,
  ) async {
    (String, bool)? called;
    await tester.pumpWidget(
      _host(
        const [_mahesh],
        onSetOwner: (entity, owner) => called = (entity.id, owner),
      ),
    );
    await tester.tap(find.text('Mahesh Kamath'));
    await tester.pump();

    expect(find.text('Unset owner'), findsOneWidget);
    await tester.tap(find.text('Unset owner'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Unset owner'));
    await tester.pumpAndSettle();
    expect(called, ('p2', false));
  });

  testWidgets('organisations, accounts and candidates get no owner toggle', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const [
          EntitySummary(
            id: 'o1',
            name: 'PetaSight Inc.',
            kind: EntityKind.organisation,
          ),
          EntitySummary(
            id: 'c1',
            name: 'Maybe Priya',
            kind: EntityKind.person,
            confirmed: false,
          ),
        ],
        onSetOwner: (_, _) {},
      ),
    );
    await tester.tap(find.text('PetaSight Inc.'));
    await tester.pump();
    expect(find.text('Make owner'), findsNothing);
    expect(find.text('Unset owner'), findsNothing);

    await tester.tap(find.text('Maybe Priya'));
    await tester.pump();
    expect(find.text('Make owner'), findsNothing);
  });
}
