/// Work order 07 §G — the intake queue.
///
/// Every incoming file — via email, the watched Drop folder, or the API —
/// appears here with its current state. Most items flow through quickly:
/// received → triaged → queued → processing → complete. Two states need
/// user attention:
///
///   - `password_needed`: the PDF is encrypted. An inline text field appears
///     in the row. The user enters the password whenever they get to it;
///     nothing else is held up.
///   - `irrelevant`: triage decided the file isn't financial. Kept safely,
///     excluded from analysis. Offers Restore.
///
/// The queue is read-only for everything else — you can see a file is
/// processing, but you can't rush it.
import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

class IntakeQueueView extends StatefulWidget {
  final VaultApi api;
  final VoidCallback? onChanged;
  const IntakeQueueView({super.key, required this.api, this.onChanged});

  @override
  State<IntakeQueueView> createState() => _IntakeQueueViewState();
}

class _IntakeQueueViewState extends State<IntakeQueueView> {
  List<IntakeEvent> _items = const [];
  bool _loading = true;
  String? _error;
  final Map<int, TextEditingController> _passwordControllers = {};
  final Map<int, bool> _submitting = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in _passwordControllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final events = await widget.api.intakeStatus(limit: 200);
      if (!mounted) return;
      // Show password_needed items first, then irrelevant, then everything
      // else sorted by recency. Active items (processing, queued) are shown
      // but most users will only look here when something needs attention.
      events.sort((a, b) {
        final aNeeds = a.needsPassword ? 0 : (a.disposition == 'irrelevant' ? 1 : 2);
        final bNeeds = b.needsPassword ? 0 : (b.disposition == 'irrelevant' ? 1 : 2);
        if (aNeeds != bNeeds) return aNeeds.compareTo(bNeeds);
        return b.id.compareTo(a.id);
      });
      setState(() {
        _items = events;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _error = VaultError.from(e).message; });
    }
  }

  Future<void> _submitPassword(IntakeEvent item) async {
    final controller = _passwordControllers[item.id];
    if (controller == null) return;
    final password = controller.text;
    if (password.isEmpty) return;

    setState(() => _submitting[item.id] = true);
    try {
      await widget.api.submitIntakePassword(item.id, password);
      if (!mounted) return;
      controller.dispose();
      _passwordControllers.remove(item.id);
      setState(() => _submitting[item.id] = false);
      _load();
      widget.onChanged?.call();
    } catch (e) {
      if (mounted) setState(() => _submitting[item.id] = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(VaultError.from(e).message)),
        );
      }
    }
  }

  Future<void> _restore(IntakeEvent item) async {
    try {
      await widget.api.restoreIntake(item.id);
      if (!mounted) return;
      await _load();
      widget.onChanged?.call();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(VaultError.from(e).message)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Text(_error!, style: TextStyle(fontSize: 12, color: VaultColors.tertiary)),
        ),
      );
    }

    if (_items.isEmpty) {
      return const SizedBox.shrink();
    }

    // Split into sections: needs attention first, then recent activity.
    final needsAttention = _items.where((e) => e.needsPassword || e.disposition == 'irrelevant').toList();
    final recent = _items.where((e) => !e.needsPassword && e.disposition != 'irrelevant').take(20).toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 30),
      children: [
        if (needsAttention.isNotEmpty) ...[
          _SectionHeader('Needs attention'),
          ...needsAttention.map((item) => _IntakeRow(
            item: item,
            passwordController: _passwordControllers.putIfAbsent(item.id, () => TextEditingController()),
            submitting: _submitting[item.id] ?? false,
            onSubmitPassword: () => _submitPassword(item),
            onRestore: () => _restore(item),
          )),
          const SizedBox(height: 20),
        ],
        if (recent.isNotEmpty) ...[
          _SectionHeader('Recent'),
          ...recent.map((item) => _IntakeRow(
            item: item,
            passwordController: null,
            submitting: false,
            onSubmitPassword: null,
            onRestore: null,
          )),
        ],
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String text;
  const _SectionHeader(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w600,
          color: VaultColors.secondary,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

class _IntakeRow extends StatelessWidget {
  final IntakeEvent item;
  final TextEditingController? passwordController;
  final bool submitting;
  final VoidCallback? onSubmitPassword;
  final VoidCallback? onRestore;

  const _IntakeRow({
    required this.item,
    required this.passwordController,
    required this.submitting,
    required this.onSubmitPassword,
    required this.onRestore,
  });

  @override
  Widget build(BuildContext context) {
    if (item.needsPassword) {
      return _passwordRow(context);
    }
    return _plainRow(context);
  }

  Widget _passwordRow(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(13, 11, 13, 11),
      decoration: vaultCard(
        border: VaultColors.warn.withValues(alpha: 0.4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.lock_outline, size: 14, color: VaultColors.warn),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  item.filename,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: VaultColors.primary),
                ),
              ),
              Text(
                'Encrypted',
                style: TextStyle(fontSize: 10, color: VaultColors.warn),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: SizedBox(
                  height: 28,
                  child: TextField(
                    controller: passwordController,
                    obscureText: true,
                    style: const TextStyle(fontSize: 12, color: VaultColors.primary),
                    decoration: InputDecoration(
                      hintText: 'Password',
                      hintStyle: TextStyle(fontSize: 11, color: VaultColors.tertiary),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(4),
                        borderSide: BorderSide(color: VaultColors.line),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(4),
                        borderSide: BorderSide(color: VaultColors.accent, width: 1),
                      ),
                    ),
                    onSubmitted: (_) => onSubmitPassword?.call(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                height: 28,
                child: ElevatedButton(
                  onPressed: submitting || onSubmitPassword == null ? null : onSubmitPassword,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: VaultColors.accent,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
                    elevation: 0,
                  ),
                  child: submitting
                    ? const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('Unlock', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _plainRow(BuildContext context) {
    final isIrrelevant = item.disposition == 'irrelevant';
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(13, 9, 13, 9),
      decoration: vaultCard(
        border: isIrrelevant ? VaultColors.line : VaultColors.line,
      ),
      child: Row(
        children: [
          _StateDot(item),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.filename,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: VaultColors.primary),
                ),
                if (item.reason != null && isIrrelevant)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      item.reason!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 10.5, color: VaultColors.tertiary, height: 1.4),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            item.stageLabel,
            style: TextStyle(fontSize: 10, color: VaultColors.tertiary),
          ),
          if (isIrrelevant && onRestore != null) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap: onRestore,
              child: Text(
                'Restore',
                style: TextStyle(fontSize: 10.5, color: VaultColors.accent, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _StateDot extends StatelessWidget {
  final IntakeEvent item;
  const _StateDot(this.item);

  @override
  Widget build(BuildContext context) {
    final color = switch (item.processingState) {
      'complete' => VaultColors.ok,
      'failed' => VaultColors.warn,
      'password_needed' => VaultColors.warn,
      'processing' => VaultColors.accent,
      'queued' => VaultColors.accent,
      'triaged' => VaultColors.ink,
      _ => VaultColors.tertiary,
    };
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
      ),
    );
  }
}
