import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/people/view.dart';

void main() {
  testWidgets('narrow entity desk constrains selected detail', (tester) async {
    tester.view.physicalSize = const Size(400, 500);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: EntityDesk(
            entities: [
              EntitySummary(
                id: 'person-1',
                name: 'Priya Nair',
                kind: EntityKind.person,
                documents: 2,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.tap(find.text('Priya Nair'));
    await tester.pump();

    expect(find.text('Aliases'), findsOneWidget);
    expect(find.text('Merge only with persons'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
