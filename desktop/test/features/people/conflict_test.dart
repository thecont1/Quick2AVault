// WO11 A3 — cross-kind identifier collisions on the People desk.
//
// A person and an organisation sharing an email are rendered as a Conflicts
// section with a keep-separate action. A merge is never offered from it, and
// the copy never implies one is possible.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/people/view.dart';

const _conflict = EntityConflict(
  identifier: 'shared@example.com',
  identifierType: 'email',
  otherId: 'o1',
  otherName: 'Nair Consulting LLP',
  otherKind: EntityKind.organisation,
);

const _person = EntitySummary(
  id: 'p1',
  name: 'Priya Nair',
  kind: EntityKind.person,
  conflicts: [_conflict],
);

Widget _host(
  List<EntitySummary> entities, {
  void Function(EntitySummary, EntityConflict)? onKeepSeparate,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 900,
      child: EntityDesk(entities: entities, onKeepSeparate: onKeepSeparate),
    ),
  ),
);

void main() {
  testWidgets('a cross-kind collision renders both entities and the shared '
      'identifier, with keep-separate and no merge offer', (tester) async {
    (String, String)? called;
    await tester.pumpWidget(
      _host(
        const [
          _person,
          EntitySummary(
            id: 'o1',
            name: 'Nair Consulting LLP',
            kind: EntityKind.organisation,
          ),
        ],
        onKeepSeparate: (entity, conflict) =>
            called = (entity.id, conflict.otherId),
      ),
    );
    await tester.tap(find.text('Priya Nair'));
    await tester.pump();

    expect(find.text('Conflicts'), findsOneWidget);
    expect(
      find.text('Same email on a person and an organisation'),
      findsOneWidget,
    );
    expect(find.text('Priya Nair · Nair Consulting LLP'), findsOneWidget);
    expect(find.text('shared@example.com'), findsOneWidget);
    expect(find.text('Keep separate'), findsOneWidget);
    // The card must not imply a merge is possible.
    expect(
      find.textContaining('Match'),
      findsNothing,
      reason: 'cross-kind is a conflict, never a match',
    );

    await tester.tap(find.text('Keep separate'));
    await tester.pump();
    expect(called, ('p1', 'o1'));
  });

  testWidgets('no conflicts, no Conflicts section', (tester) async {
    await tester.pumpWidget(
      _host(
        const [
          EntitySummary(id: 'p2', name: 'Arun Kamath', kind: EntityKind.person),
        ],
        onKeepSeparate: (_, _) {},
      ),
    );
    await tester.tap(find.text('Arun Kamath'));
    await tester.pump();
    expect(find.text('Conflicts'), findsNothing);
  });
}
