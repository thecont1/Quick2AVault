import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Statement import summary card (work order 04 §A.6).
///
/// N lines read, M linked to an existing transaction, K created new, G gaps
/// — the gaps ARE the point of the whole feature: a card charge with no
/// invoice ever seen for it. Per-line drill-down expands below the totals.
///
/// Shown only for bank_statement/card_statement documents; the Document
/// Browser simply omits this card for anything else (StatementCard.forDoc
/// returns null rather than an empty shell).
class StatementCard extends StatefulWidget {
  const StatementCard({super.key, required this.api, required this.documentId});

  final VaultApi api;
  final String documentId;

  @override
  State<StatementCard> createState() => _StatementCardState();
}

class _StatementCardState extends State<StatementCard> {
  StatementSummary? _summary;
  String? _error;
  bool _loading = true;
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(StatementCard old) {
    super.didUpdateWidget(old);
    if (old.documentId != widget.documentId) _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _summary = null;
    });
    try {
      final s = await widget.api.statementFor(widget.documentId);
      if (mounted) setState(() => _summary = s);
    } on NotAStatement {
      // Not an error state — most documents are not statements. The caller
      // (Document Browser) should not render this widget at all once it
      // knows doc_type, but if it does, fail silently rather than showing a
      // scary red box for the common case.
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: SizedBox(
          height: 16,
          width: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(
          'Could not load statement: $_error',
          style: const TextStyle(fontSize: 11.5, color: VaultColors.faint),
        ),
      );
    }
    final s = _summary;
    if (s == null) return const SizedBox.shrink(); // not a statement

    return Container(
      margin: const EdgeInsets.only(top: 8, bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: VaultColors.panel,
        border: Border.all(color: VaultColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.receipt_long_outlined, size: 15, color: VaultColors.ink),
              const SizedBox(width: 6),
              const Text(
                'Statement import',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: VaultColors.ink),
              ),
              const Spacer(),
              TextButton(
                onPressed: () => setState(() => _expanded = !_expanded),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(
                  _expanded ? 'Hide lines' : 'Show ${s.total} lines',
                  style: const TextStyle(fontSize: 11, color: VaultColors.ok),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 18,
            runSpacing: 6,
            children: [
              _Stat(label: '${s.total} lines read', color: VaultColors.ink),
              _Stat(label: '${s.linked} linked', color: VaultColors.ok),
              _Stat(label: '${s.created} created', color: VaultColors.ink),
              if (s.gaps > 0)
                _Stat(
                  label: '${s.gaps} gap${s.gaps == 1 ? '' : 's'} — no invoice on file',
                  color: const Color(0xFFB45309),
                  emphasise: true,
                ),
              if (s.pending > 0) _Stat(label: '${s.pending} awaiting review', color: VaultColors.faint),
            ],
          ),
          if (_expanded) ...[
            const SizedBox(height: 12),
            const Divider(height: 1, color: VaultColors.line),
            const SizedBox(height: 8),
            ...s.lines.map((l) => _LineRow(line: l)),
          ],
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.color, this.emphasise = false});
  final String label;
  final Color color;
  final bool emphasise;

  @override
  Widget build(BuildContext context) => Text(
        label,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: emphasise ? FontWeight.w700 : FontWeight.w500,
          color: color,
        ),
      );
}

/// One row in the drill-down list. Tapping opens the linked/created
/// transaction — the same evidence trail every other document offers, so a
/// statement line is not a second-class citizen once it becomes a real txn.
class _LineRow extends StatelessWidget {
  const _LineRow({required this.line});
  final StatementLine line;

  Color _statusColor() {
    if (line.isGap) return const Color(0xFFB45309);
    switch (line.status) {
      case 'linked':
        return VaultColors.ok;
      case 'created':
        return VaultColors.ink;
      case 'pending':
        return VaultColors.faint;
      default:
        return VaultColors.faint;
    }
  }

  String _statusLabel() {
    if (line.isGap) return 'gap — no invoice';
    switch (line.status) {
      case 'linked':
        return 'linked';
      case 'created':
        return 'created';
      case 'pending':
        return 'review';
      case 'skipped':
        return 'skipped';
      default:
        return line.status;
    }
  }

  @override
  Widget build(BuildContext context) {
    final sign = line.direction == 'out' ? '-' : '+';
    // The line's own currency (statement header, or the line's FX override) —
    // a foreign-currency line must never read as home currency.
    final amount = '$sign${money(line.amountMinor, line.currency)}';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 78,
            child: Text(
              line.occurredAt ?? '—',
              style: const TextStyle(fontSize: 10.5, fontFamily: VaultType.mono, color: VaultColors.faint),
            ),
          ),
          Expanded(
            child: Text(
              line.counterpartyName ?? line.rawDescriptor,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: VaultColors.ink),
            ),
          ),
          if (line.fxOriginal != null) ...[
            Text(
              '${line.fxOriginal!.currency} ${(line.fxOriginal!.amountMinor / 100).toStringAsFixed(2)}',
              style: const TextStyle(fontSize: 10, color: VaultColors.faint),
            ),
            const SizedBox(width: 8),
          ],
          SizedBox(
            width: 90,
            child: Text(
              amount,
              textAlign: TextAlign.right,
              style: TextStyle(
                fontSize: 11.5,
                fontFamily: VaultType.mono,
                color: line.direction == 'out' ? VaultColors.ink : VaultColors.ok,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              border: Border.all(color: _statusColor().withValues(alpha: 0.4)),
              borderRadius: BorderRadius.circular(3),
            ),
            child: Text(
              _statusLabel(),
              style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w600, color: _statusColor()),
            ),
          ),
        ],
      ),
    );
  }
}
