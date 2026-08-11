library;

import 'package:flutter/material.dart';

import '../../theme.dart';
import 'state.dart';

export 'state.dart';

/// An in-window, dismissible learning surface. It deliberately does not own a
/// tab: the settings screen remains authoritative for the master switch.
class LearningPanel extends StatelessWidget {
  final bool enabled;
  final List<LearningPrompt> questions;
  final ValueChanged<String>? onAction;
  final VoidCallback? onOpenReview;

  const LearningPanel({
    super.key,
    required this.enabled,
    this.questions = const [],
    this.onAction,
    this.onOpenReview,
  });

  @override
  Widget build(BuildContext context) => Semantics(
    label: enabled
        ? 'Learning, ${questions.length} pending'
        : 'Learning is off',
    child: Material(
      color: VaultColors.panel,
      child: SafeArea(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.auto_awesome_outlined,
                    size: 18,
                    color: VaultColors.accent,
                  ),
                  const SizedBox(width: 9),
                  const Expanded(
                    child: Text(
                      'Learning',
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                        color: VaultColors.ink,
                      ),
                    ),
                  ),
                  _StateChip(enabled: enabled),
                ],
              ),
              const SizedBox(height: 18),
              if (!enabled)
                const _PanelMessage(
                  title: 'Learning is off',
                  detail:
                      'Corrections still teach the vault. New questions are paused in App Settings.',
                )
              else if (questions.isEmpty)
                const _PanelMessage(
                  title: 'Nothing needs teaching',
                  detail:
                      'New, high-novelty ambiguities will appear here after analysis.',
                )
              else
                for (final question in questions) ...[
                  _PromptCard(question: question, onAction: onAction),
                  const SizedBox(height: 12),
                ],
              if (onOpenReview != null) ...[
                const SizedBox(height: 8),
                TextButton.icon(
                  onPressed: onOpenReview,
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: const Text('Open Review'),
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}

class _PromptCard extends StatelessWidget {
  final LearningPrompt question;
  final ValueChanged<String>? onAction;
  const _PromptCard({required this.question, this.onAction});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(16),
    decoration: vaultCard(border: VaultColors.line),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          question.trigger.toUpperCase(),
          style: const TextStyle(
            color: VaultColors.accent,
            fontSize: 10,
            letterSpacing: 0.8,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          question.prompt,
          style: const TextStyle(
            color: VaultColors.ink,
            fontSize: 15,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 10),
        const Text(
          'Why I’m asking',
          style: TextStyle(
            color: VaultColors.dim,
            fontSize: 11,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          question.why,
          style: const TextStyle(
            color: VaultColors.dim,
            fontSize: 12,
            height: 1.35,
          ),
        ),
        const SizedBox(height: 14),
        // WO12 phase 2: reconciliation-ambiguity questions get
        // Link / Don't link / Later buttons instead of the generic
        // Confirm / Choose / Create / Later set. The trigger field
        // distinguishes the two question types.
        if (question.trigger == 'reconciliation-ambiguity')
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton(
                onPressed: () => onAction?.call('link:${question.id}'),
                child: const Text('Link'),
              ),
              OutlinedButton(
                onPressed: () => onAction?.call('dismiss:${question.id}'),
                child: const Text("Don't link"),
              ),
              TextButton(
                onPressed: () => onAction?.call('later:${question.id}'),
                child: const Text('Later'),
              ),
            ],
          )
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton(
                onPressed: () => onAction?.call('confirm:${question.id}'),
                child: const Text('Confirm'),
              ),
              OutlinedButton(
                onPressed: () => onAction?.call('choose:${question.id}'),
                child: const Text('Choose from list'),
              ),
              OutlinedButton(
                onPressed: () => onAction?.call('create:${question.id}'),
                child: const Text('Create new'),
              ),
              TextButton(
                onPressed: () => onAction?.call('later:${question.id}'),
                child: const Text('Later'),
              ),
            ],
          ),
      ],
    ),
  );
}

class _StateChip extends StatelessWidget {
  final bool enabled;
  const _StateChip({required this.enabled});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: vaultPill(
      fill: (enabled ? VaultColors.ok : VaultColors.faint).withValues(
        alpha: .12,
      ),
      border: (enabled ? VaultColors.ok : VaultColors.faint).withValues(
        alpha: .35,
      ),
    ),
    child: Text(
      enabled ? 'On' : 'Off',
      style: TextStyle(
        color: enabled ? VaultColors.ok : VaultColors.faint,
        fontSize: 11,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
}

class _PanelMessage extends StatelessWidget {
  final String title;
  final String detail;
  const _PanelMessage({required this.title, required this.detail});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: vaultCard(border: VaultColors.line),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            color: VaultColors.ink,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          detail,
          style: const TextStyle(color: VaultColors.dim, height: 1.4),
        ),
      ],
    ),
  );
}
