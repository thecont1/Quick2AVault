import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/learning/view.dart';
import 'package:quick2avault_desktop/features/settings/view.dart';
import 'package:quick2avault_desktop/features/workspace_shell.dart';
import 'package:quick2avault_desktop/widgets/vault_tabs.dart';

const _prompt = LearningPrompt(
  id: 'q1',
  prompt: 'Is PetaSight an organisation?',
  why: 'This name is new on an invoice.',
  trigger: 'new entity',
  novelty: 0.88,
);

void main() {
  testWidgets('Learning is an in-window drawer, not a seventh tab', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: WorkspaceShell(
              tab: VaultTab.ledger,
              onTabChanged: (_) {},
              learningEnabled: true,
              learningQuestions: const [_prompt],
              intakeArrivals: 0,
              onOpenLearning: () => WorkspaceShell.showLearningDrawer(
                context,
                enabled: true,
                questions: const [_prompt],
              ),
              onOpenIntake: (_) {},
              body: const Text('Ledger body'),
            ),
          ),
        ),
      ),
    );

    for (final tab in VaultTab.values) {
      expect(find.text(tab.label), findsOneWidget);
    }
    expect(VaultTab.values, hasLength(6));
    expect(find.text(_prompt.prompt), findsNothing);

    await tester.tap(find.text('Learning on · 1 pending'));
    await tester.pumpAndSettle();

    expect(find.text(_prompt.prompt), findsOneWidget);
    expect(find.text('Why I’m asking'), findsOneWidget);
  });

  testWidgets('settings rebuild reflects an external learning toggle', (
    tester,
  ) async {
    const key = ValueKey('settings');
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: AppSettingsView(
            key: key,
            initial: AppSettings(learningEnabled: false, questionBudget: null),
          ),
        ),
      ),
    );
    expect(find.text('Learning is off'), findsOneWidget);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: AppSettingsView(
            key: key,
            initial: AppSettings(learningEnabled: true, questionBudget: 5),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Learning is on'), findsOneWidget);
    final selected = tester.widget<ChoiceChip>(
      find.widgetWithText(ChoiceChip, '5 questions'),
    );
    expect(selected.selected, isTrue);
  });
}
