import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/vault_tabs.dart';
import 'learning/state.dart';
import 'learning/view.dart';

class WorkspaceShell extends StatelessWidget {
  final VaultTab tab;
  final ValueChanged<VaultTab> onTabChanged;
  final bool learningEnabled;
  final List<LearningPrompt> learningQuestions;
  final int intakeArrivals;
  final String? latestIntakeId;
  final VoidCallback onOpenLearning;
  final ValueChanged<String?> onOpenIntake;
  final Widget body;

  const WorkspaceShell({
    super.key,
    required this.tab,
    required this.onTabChanged,
    required this.learningEnabled,
    required this.learningQuestions,
    required this.intakeArrivals,
    this.latestIntakeId,
    required this.onOpenLearning,
    required this.onOpenIntake,
    required this.body,
  });

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Container(
        padding: const EdgeInsets.fromLTRB(28, 18, 24, 12),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: VaultColors.line)),
        ),
        child: Row(
          children: [
            const Expanded(
              child: Text(
                'Quick2AVault',
                style: TextStyle(
                  color: VaultColors.ink,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            TextButton.icon(
              onPressed: learningEnabled ? onOpenLearning : null,
              icon: const Icon(Icons.auto_awesome_outlined, size: 16),
              label: Text(
                learningEnabled
                    ? 'Learning on · ${learningQuestions.length} pending'
                    : 'Learning off',
              ),
            ),
            const SizedBox(width: 8),
            TextButton.icon(
              onPressed: intakeArrivals > 0
                  ? () => onOpenIntake(latestIntakeId)
                  : null,
              icon: const Icon(Icons.inbox_outlined, size: 16),
              label: Text('$intakeArrivals arrivals'),
            ),
          ],
        ),
      ),
      VaultTabBar(
        current: tab,
        onChanged: onTabChanged,
        disabled: const {VaultTab.charts},
      ),
      Expanded(child: body),
    ],
  );

  static Future<void> showLearningDrawer(
    BuildContext context, {
    required bool enabled,
    required List<LearningPrompt> questions,
    ValueChanged<String>? onAction,
    VoidCallback? onOpenReview,
  }) => showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 460),
    builder: (context) => LearningPanel(
      enabled: enabled,
      questions: questions,
      onAction: onAction,
      onOpenReview: onOpenReview,
    ),
  );
}
