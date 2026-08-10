import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/learning/view.dart';
import 'package:quick2avault_desktop/features/settings/view.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('Learning is an in-window drawer, not a seventh tab', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        LearningPanel(
          enabled: true,
          questions: const [
            LearningPrompt(
              id: 'q1',
              prompt: 'Is PetaSight an organisation?',
              why: 'This name is new on an invoice.',
              trigger: 'new entity',
              novelty: 0.88,
            ),
          ],
        ),
      ),
    );

    expect(find.text('Learning'), findsOneWidget);
    expect(find.text('Is PetaSight an organisation?'), findsOneWidget);
    expect(find.text('Why I’m asking'), findsOneWidget);
    expect(find.text('Confirm'), findsOneWidget);
    expect(find.text('Choose from list'), findsOneWidget);
    expect(find.text('Create new'), findsOneWidget);
    expect(find.text('Later'), findsOneWidget);
  });

  testWidgets(
    'disabled learning state remains visibly disabled after rebuild',
    (tester) async {
      await tester.pumpWidget(
        _host(
          const AppSettingsView(
            initial: AppSettings(learningEnabled: false, questionBudget: null),
          ),
        ),
      );

      expect(find.text('Learning is off'), findsOneWidget);
      expect(find.text('Auto'), findsOneWidget);
    },
  );
}
