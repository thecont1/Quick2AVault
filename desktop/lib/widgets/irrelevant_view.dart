import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Work order 06 §9 — Irrelevant view.
///
/// Shows files triaged as irrelevant with the message "Kept safely, excluded
/// from financial analysis." Each row offers Open and Restore/Re-triage.
/// Destructive deletion is NOT here — it lives in Danger Zone, explicit and
/// separate, so an accidental click in this view can never destroy a file.
class IrrelevantView extends StatefulWidget {
  final VaultApi api;
  final VoidCallback? onRestored;
  const IrrelevantView({super.key, required this.api, this.onRestored});

  @override
  State<IrrelevantView> createState() => _IrrelevantViewState();
}

class _IrrelevantViewState extends State<IrrelevantView> {
  List<IntakeEvent> _items = const [];
  bool _loading = true;
  String? _error;

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
      final items = await widget.api.irrelevantItems();
      if (mounted) setState(() => _items = items);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _restore(IntakeEvent item) async {
    try {
      await widget.api.restoreIntake(item.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Restored "${item.filename}" — re-triaged'),
      ));
      await _load();
      widget.onRestored?.call();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Restore failed: $e'),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text('Could not load irrelevant items:\n$_error',
              style: const TextStyle(color: VaultColors.dim, fontSize: 13)),
        ),
      );
    }
    if (_items.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(40),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.inbox_outlined, size: 32, color: VaultColors.faint),
            SizedBox(height: 14),
            Text('No irrelevant items',
                style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: VaultColors.ink)),
            SizedBox(height: 7),
            Text(
              'Files triaged as irrelevant will appear here.\n'
              'Kept safely, excluded from financial analysis.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, height: 1.55, color: VaultColors.dim),
            ),
          ]),
        ),
      );
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      // Header with the §9 message.
      Container(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 14),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: VaultColors.line)),
        ),
        child: const Row(children: [
          Icon(Icons.archive_outlined, size: 18, color: VaultColors.dim),
          SizedBox(width: 9),
          Expanded(
            child: Text(
              'Irrelevant — kept safely, excluded from financial analysis.',
              style: TextStyle(fontSize: 13, color: VaultColors.dim),
            ),
          ),
        ]),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView.separated(
            padding: const EdgeInsets.only(bottom: 30),
            itemCount: _items.length,
            separatorBuilder: (_, _) =>
                const Divider(height: 1, color: VaultColors.line),
            itemBuilder: (context, i) => _IrrelevantRow(
              item: _items[i],
              onRestore: () => _restore(_items[i]),
            ),
          ),
        ),
      ),
    ]);
  }
}

class _IrrelevantRow extends StatelessWidget {
  final IntakeEvent item;
  final VoidCallback onRestore;
  const _IrrelevantRow({required this.item, required this.onRestore});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 12, 20, 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        // Disposition dot — dim grey for irrelevant.
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Container(
            width: 7,
            height: 7,
            decoration: const BoxDecoration(
              color: VaultColors.faint,
              shape: BoxShape.circle,
            ),
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(item.filename,
                style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: VaultColors.ink)),
            const SizedBox(height: 3),
            if (item.reason != null)
              Text(item.reason!,
                  style: const TextStyle(fontSize: 12, color: VaultColors.dim)),
            const SizedBox(height: 2),
            Text(
              '${item.reasonCode ?? "irrelevant"}  ·  ${item.source}  ·  ${_shortDate(item.createdAt)}',
              style: const TextStyle(
                  fontSize: 11, fontFamily: VaultType.mono, color: VaultColors.faint),
            ),
          ]),
        ),
        const SizedBox(width: 10),
        // Restore / Re-triage button.
        TextButton.icon(
          onPressed: onRestore,
          icon: const Icon(Icons.restore, size: 14),
          label: const Text('Restore', style: TextStyle(fontSize: 12)),
          style: TextButton.styleFrom(
            foregroundColor: VaultColors.accent,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            minimumSize: const Size(0, 30),
          ),
        ),
      ]),
    );
  }

  String _shortDate(DateTime d) {
    final s = d.toIso8601String();
    return s.length >= 10 ? s.substring(0, 10) : s;
  }
}
