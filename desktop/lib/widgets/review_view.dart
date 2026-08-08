import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Learning Mode — the review queue.
///
/// This is the vault's primary input channel: most of what it knows arrives by
/// the user answering a question here, not by manual entry. So the screen is
/// built around one idea — an answer must be DURABLE. Every question is
/// answered as a rule, and the rule is shown afterwards, because a correction
/// that only fixes one row is a chore, while a correction that teaches the
/// vault forever is worth the interruption.
///
/// Design constraints that follow from that:
///   * one question at a time, large, with its evidence — not a dense list
///   * the rule that WILL be created is stated before you commit to it
///   * skipping is always available and never creates a rule
///   * what has already been learned is visible, so the work feels cumulative
class ReviewView extends StatefulWidget {
  final VaultApi api;
  final VoidCallback onClose;
  /// Called after any answer or dismissal so the caller can refresh its badge.
  final VoidCallback? onChanged;

  const ReviewView({
    super.key,
    required this.api,
    required this.onClose,
    this.onChanged,
  });

  @override
  State<ReviewView> createState() => _ReviewViewState();
}

class _ReviewViewState extends State<ReviewView> {
  LearningState _state = LearningState.empty;
  bool _loading = true;
  String? _error;
  int _index = 0;
  bool _busy = false;
  /// Set briefly after an answer so the user sees what was learned.
  String? _lastLearned;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final s = await widget.api.learningState();
      if (!mounted) return;
      setState(() {
        _state = s;
        _loading = false;
        // Keep the cursor in range as the queue shrinks.
        if (_index >= s.questions.length) _index = 0;
      });
    } on VaultAuthException catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = '$e'; _loading = false; });
    }
  }

  LearningQuestion? get _current =>
      _index < _state.questions.length ? _state.questions[_index] : null;

  /// The rule an answer will create, derived from the question's trigger.
  ///
  /// Returning null means "no rule" — the answer is then a one-off and the UI
  /// says so rather than implying the vault learned something it did not.
  ({String kind, String matchKey, String value})? _ruleFor(
    LearningQuestion q,
    String answer,
  ) {
    // "No, keep separate" must never create an alias — that would teach the
    // exact opposite of what the user said.
    final affirmative = answer.toLowerCase().startsWith('yes');
    if (!affirmative) return null;

    switch (q.trigger) {
      case 'unseen_entity':
        final d = q.descriptor;
        final e = q.entityName;
        if (d == null || e == null) return null;
        return (kind: 'entity_alias', matchKey: d, value: e);
      case 'ambiguous_category':
        final d = q.descriptor ?? q.entityName;
        if (d == null) return null;
        return (kind: 'doctype_to_category', matchKey: d, value: answer);
      case 'load_vs_spend':
        final d = q.descriptor ?? q.entityName;
        if (d == null) return null;
        return (kind: 'load_vs_spend', matchKey: d, value: answer);
      default:
        return null;
    }
  }

  Future<void> _answer(LearningQuestion q, String answer) async {
    if (_busy) return;
    setState(() => _busy = true);
    final rule = _ruleFor(q, answer);
    try {
      await widget.api.answerLearning(
        q.id,
        answer,
        ruleKind: rule?.kind,
        matchKey: rule?.matchKey,
        value: rule?.value,
      );
      if (!mounted) return;
      setState(() {
        _lastLearned = rule == null
            ? 'Answered. No rule created — this was a one-off.'
            : 'Learned: ${rule.matchKey} → ${rule.value}';
        _busy = false;
      });
      widget.onChanged?.call();
      await _load();
    } catch (e) {
      if (mounted) setState(() { _error = '$e'; _busy = false; });
    }
  }

  Future<void> _skip(LearningQuestion q) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await widget.api.dismissLearning(q.id);
      if (!mounted) return;
      setState(() { _lastLearned = null; _busy = false; });
      widget.onChanged?.call();
      await _load();
    } catch (e) {
      if (mounted) setState(() { _error = '$e'; _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      _Header(
        answered: _state.answered,
        pending: _state.questions.length,
        enabled: _state.enabled,
        onClose: widget.onClose,
      ),
      const Divider(height: 1, color: VaultColors.line),
      Expanded(
        child: _loading
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : _error != null
                ? _ErrorState(message: _error!, onRetry: _load)
                : !_state.enabled
                    ? const _DisabledState()
                    : _current == null
                        ? _AllCaughtUp(
                            answered: _state.answered,
                            rules: _state.rules,
                          )
                        : _QuestionCard(
                            question: _current!,
                            busy: _busy,
                            learned: _lastLearned,
                            rulePreview: (a) => _ruleFor(_current!, a),
                            onAnswer: (a) => _answer(_current!, a),
                            onSkip: () => _skip(_current!),
                          ),
      ),
      if (_state.rules.isNotEmpty && _current != null) ...[
        const Divider(height: 1, color: VaultColors.line),
        _LearnedStrip(rules: _state.rules),
      ],
    ]);
  }
}

class _Header extends StatelessWidget {
  final int answered;
  final int pending;
  final bool enabled;
  final VoidCallback onClose;

  const _Header({
    required this.answered,
    required this.pending,
    required this.enabled,
    required this.onClose,
  });

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 12, 16),
        child: Row(children: [
          const Text('Document Review',
              style: TextStyle(
                  fontSize: 20, fontWeight: FontWeight.w700, color: VaultColors.ink)),
          const SizedBox(width: 12),
          if (pending > 0)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: VaultColors.accent.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text('$pending pending',
                  style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                      color: VaultColors.accent)),
            ),
          const Spacer(),
          // The cumulative count: this is what makes the work feel worthwhile.
          Text(
            answered == 0
                ? 'nothing learned yet'
                : '$answered ${answered == 1 ? "answer" : "answers"} taught',
            style: const TextStyle(fontSize: 12, color: VaultColors.dim),
          ),
          const SizedBox(width: 12),
          IconButton(
            onPressed: onClose,
            icon: const Icon(Icons.close, size: 18),
            tooltip: 'Close',
          ),
        ]),
      );
}

class _QuestionCard extends StatelessWidget {
  final LearningQuestion question;
  final bool busy;
  final String? learned;
  final ({String kind, String matchKey, String value})? Function(String) rulePreview;
  final void Function(String) onAnswer;
  final VoidCallback onSkip;

  const _QuestionCard({
    required this.question,
    required this.busy,
    required this.learned,
    required this.rulePreview,
    required this.onAnswer,
    required this.onSkip,
  });

  @override
  Widget build(BuildContext context) {
    // Fall back to yes/no when the daemon supplied no options, so a question
    // is never unanswerable.
    final options = question.options.isEmpty
        ? const ['Yes, always', 'No, keep separate']
        : question.options;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (learned != null) ...[
          _LearnedToast(text: learned!),
          const SizedBox(height: 18),
        ],
        Text(_triggerLabel(question.trigger),
            style: const TextStyle(
                fontSize: 11,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w700,
                color: VaultColors.faint)),
        const SizedBox(height: 10),
        Text(question.question,
            style: const TextStyle(
                fontSize: 22, height: 1.35, color: VaultColors.ink)),
        const SizedBox(height: 20),
        // Show the two things being compared side by side. The question text
        // alone is easy to misread when the strings are long and similar.
        if (question.descriptor != null && question.entityName != null)
          _Comparison(
            left: question.descriptor!,
            right: question.entityName!,
          ),
        const SizedBox(height: 24),
        for (final o in options) ...[
          _AnswerButton(
            label: o,
            rule: rulePreview(o),
            busy: busy,
            onPressed: () => onAnswer(o),
          ),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 6),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: busy ? null : onSkip,
            child: const Text('Skip — do not ask about this again',
                style: TextStyle(fontSize: 12.5, color: VaultColors.dim)),
          ),
        ),
      ]),
    );
  }

  static String _triggerLabel(String t) => switch (t) {
        'unseen_entity' => 'NEW COUNTERPARTY',
        'ambiguous_category' => 'UNCLEAR CATEGORY',
        'load_vs_spend' => 'WALLET TOP-UP OR SPEND?',
        _ => t.toUpperCase().replaceAll('_', ' '),
      };
}

/// The two strings under comparison, shown plainly. Long bank descriptors are
/// hard to compare inside a sentence.
class _Comparison extends StatelessWidget {
  final String left;
  final String right;
  const _Comparison({required this.left, required this.right});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: VaultColors.controlSubtle40,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: VaultColors.line),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('ON THE DOCUMENT',
                  style: TextStyle(
                      fontSize: 9.5, letterSpacing: 0.6, color: VaultColors.faint)),
              const SizedBox(height: 5),
              SelectableText(left,
                  style: const TextStyle(
                      fontSize: 13.5,
                      fontFamily: 'Menlo',
                      color: VaultColors.ink)),
            ]),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 12),
            child: Icon(Icons.arrow_forward, size: 15, color: VaultColors.faint),
          ),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('KNOWN AS',
                  style: TextStyle(
                      fontSize: 9.5, letterSpacing: 0.6, color: VaultColors.faint)),
              const SizedBox(height: 5),
              SelectableText(right,
                  style: const TextStyle(
                      fontSize: 13.5, fontWeight: FontWeight.w600, color: VaultColors.ink)),
            ]),
          ),
        ]),
      );
}

/// An answer, with the rule it will create stated up front.
///
/// Showing the consequence before the click is the honest thing to do: these
/// answers persist and shape every future document, so the user should not
/// have to guess whether "Yes" means "just this once" or "forever".
class _AnswerButton extends StatelessWidget {
  final String label;
  final ({String kind, String matchKey, String value})? rule;
  final bool busy;
  final VoidCallback onPressed;

  const _AnswerButton({
    required this.label,
    required this.rule,
    required this.busy,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final teaches = rule != null;
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        onPressed: busy ? null : onPressed,
        style: OutlinedButton.styleFrom(
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          side: BorderSide(
            color: teaches ? VaultColors.accent : VaultColors.line,
            width: teaches ? 1.4 : 1,
          ),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: teaches ? VaultColors.accent : VaultColors.ink)),
          const SizedBox(height: 3),
          Text(
            teaches
                ? 'Always: ${rule!.matchKey} → ${rule!.value}'
                : 'Applies to this document only',
            style: const TextStyle(fontSize: 11.5, color: VaultColors.dim),
          ),
        ]),
      ),
    );
  }
}

class _LearnedToast extends StatelessWidget {
  final String text;
  const _LearnedToast({required this.text});

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: VaultColors.ok.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(children: [
          const Icon(Icons.check_circle_outline, size: 15, color: VaultColors.ok),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text,
                style: const TextStyle(fontSize: 12.5, color: VaultColors.ink)),
          ),
        ]),
      );
}

class _AllCaughtUp extends StatelessWidget {
  final int answered;
  final List<LearnedRule> rules;
  const _AllCaughtUp({required this.answered, required this.rules});

  @override
  Widget build(BuildContext context) => Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.check_circle_outline, size: 34, color: VaultColors.ok),
            const SizedBox(height: 14),
            const Text('Nothing to review',
                style: TextStyle(
                    fontSize: 17, fontWeight: FontWeight.w600, color: VaultColors.ink)),
            const SizedBox(height: 7),
            Text(
              answered == 0
                  ? 'Questions appear here when a document contains something new.'
                  : 'You have taught the vault $answered ${answered == 1 ? "thing" : "things"}. '
                      'New questions appear as documents arrive.',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 13, height: 1.5, color: VaultColors.dim),
            ),
            if (rules.isNotEmpty) ...[
              const SizedBox(height: 26),
              const Text('WHAT THE VAULT KNOWS',
                  style: TextStyle(
                      fontSize: 10,
                      letterSpacing: 0.8,
                      fontWeight: FontWeight.w700,
                      color: VaultColors.faint)),
              const SizedBox(height: 12),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 460),
                child: Column(children: [for (final r in rules) _RuleRow(rule: r)]),
              ),
            ],
          ]),
        ),
      );
}

class _RuleRow extends StatelessWidget {
  final LearnedRule rule;
  const _RuleRow({required this.rule});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(children: [
          Expanded(
            child: Text(rule.matchKey,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontSize: 12, fontFamily: 'Menlo', color: VaultColors.dim)),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 8),
            child: Icon(Icons.arrow_forward, size: 12, color: VaultColors.faint),
          ),
          Expanded(
            child: Text(rule.value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontSize: 12, fontWeight: FontWeight.w600, color: VaultColors.ink)),
          ),
          if (rule.timesApplied > 0)
            Text('  used ${rule.timesApplied}×',
                style: const TextStyle(fontSize: 11, color: VaultColors.faint)),
        ]),
      );
}

/// A compact reminder of recent rules, kept visible while answering so the
/// work reads as cumulative rather than endless.
class _LearnedStrip extends StatelessWidget {
  final List<LearnedRule> rules;
  const _LearnedStrip({required this.rules});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
        color: VaultColors.controlSubtle40,
        child: Row(children: [
          const Text('LEARNED',
              style: TextStyle(
                  fontSize: 9.5,
                  letterSpacing: 0.7,
                  fontWeight: FontWeight.w700,
                  color: VaultColors.faint)),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              rules.take(3).map((r) => '${r.matchKey} → ${r.value}').join('   ·   '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: VaultColors.dim),
            ),
          ),
          if (rules.length > 3)
            Text('+${rules.length - 3}',
                style: const TextStyle(fontSize: 11.5, color: VaultColors.faint)),
        ]),
      );
}

class _DisabledState extends StatelessWidget {
  const _DisabledState();

  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.school_outlined, size: 32, color: VaultColors.faint),
            SizedBox(height: 14),
            Text('Learning Mode is off',
                style: TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w600, color: VaultColors.ink)),
            SizedBox(height: 7),
            Text(
              'The vault will not ask about anything new until you turn it '
              'back on from the popup.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, height: 1.5, color: VaultColors.dim),
            ),
          ]),
        ),
      );
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.error_outline, size: 30, color: VaultColors.warn),
            const SizedBox(height: 12),
            const Text('Could not load the review queue',
                style: TextStyle(
                    fontSize: 15, fontWeight: FontWeight.w600, color: VaultColors.ink)),
            const SizedBox(height: 6),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12, color: VaultColors.dim)),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ]),
        ),
      );
}
