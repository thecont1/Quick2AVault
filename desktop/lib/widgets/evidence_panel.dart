import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';
import 'editable_field.dart';

/// The "prove it" surface. Every document backing one rupee, with the
/// reference IDs that appear on MORE THAN ONE of them highlighted — those are
/// the join keys the matcher used.
///
/// Since work order 03 §P3 this is also the EDITING surface: the transaction's
/// own fields are correctable in place, each carrying a provenance badge
/// showing whether the value came from the model or from you.
class EvidencePanel extends StatefulWidget {
  final EvidenceCard card;

  /// Editing needs an API client. Omit it and the panel stays read-only, which
  /// is what the tests and any preview surface want.
  final VaultApi? api;

  /// Called after a successful edit so the shell can refetch the ledger —
  /// the resolver may have moved totals.
  final VoidCallback? onEdited;

  const EvidencePanel({super.key, required this.card, this.api, this.onEdited});

  @override
  State<EvidencePanel> createState() => _EvidencePanelState();
}

class _EvidencePanelState extends State<EvidencePanel> {
  ClaimSet _claims = ClaimSet.empty;
  bool _unlinking = false;

  @override
  void initState() {
    super.initState();
    _loadClaims();
  }

  @override
  void didUpdateWidget(EvidencePanel old) {
    super.didUpdateWidget(old);
    if (old.card.transaction.id != widget.card.transaction.id) _loadClaims();
  }

  Future<void> _handleUnlink(Evidence e) async {
    final api = widget.api;
    if (api == null) return;
    // Confirm before unlinking — the action is reversible by re-linking,
    // but the user should understand they're removing proof from this
    // transaction.
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Unlink evidence?'),
        content: Text(
          'Remove "${e.filename}" from this transaction?\n\n'
          'The document is preserved — only the link is removed. '
          'The matcher may re-link it on a future analysis.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Unlink'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _unlinking = true);
    try {
      await api.unlinkEvidence(widget.card.transaction.id, e.id);
      widget.onEdited?.call();
    } catch (_) {
      // The error is transient — the shell's refresh will show the current
      // state. A snackbar would be nicer but the panel doesn't own a Scaffold.
    } finally {
      if (mounted) setState(() => _unlinking = false);
    }
  }

  Future<void> _loadClaims() async {
    final api = widget.api;
    if (api == null) return;
    try {
      final c = await api.claims('transactions', widget.card.transaction.id);
      if (mounted) setState(() => _claims = c);
    } catch (_) {
      // Provenance is an enhancement, not a precondition. A daemon too old to
      // serve /claims still shows the evidence — it just cannot show badges.
    }
  }

  @override
  Widget build(BuildContext context) {
    final card = widget.card;
    final shared = card.sharedRefValues;
    final t = card.transaction;
    final api = widget.api;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: VaultColors.panel,
        border: Border.all(color: VaultColors.line),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(
          // Source amount AND source currency — never detached (WO 05 §A.3).
          'Evidence · ${t.sourceAmount}'
          '${t.homeAmount != null ? "  ≈ ${t.homeAmount}" : ""}'
          ' · ${t.counterparty ?? "transfer"}',
          style: const TextStyle(
              fontSize: 12.5, fontWeight: FontWeight.w600, color: VaultColors.ink),
        ),
        const SizedBox(height: 12),
        ...card.evidence.map((e) => Padding(
              padding: const EdgeInsets.only(bottom: 7),
              child: Container(
                padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
                decoration: BoxDecoration(border: Border.all(color: VaultColors.line)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(e.filename,
                            style: const TextStyle(fontSize: 12, color: VaultColors.ink)),
                      ),
                      // WO12 phase 2: refund badge for refund_note evidence
                      if (e.role == 'refund_note')
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: const Color(0xFFE0A800).withValues(alpha: .15),
                            borderRadius: BorderRadius.circular(3),
                          ),
                          child: const Text(
                            'REVERSAL',
                            style: TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFFB07A00),
                            ),
                          ),
                        ),
                      // WO12 phase 2: unlink button (only when an API client
                      // is available and we're not already unlinking)
                      if (api != null && !_unlinking)
                        IconButton(
                          icon: const Icon(Icons.link_off, size: 14, color: VaultColors.faint),
                          padding: const EdgeInsets.all(2),
                          constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                          tooltip: 'Unlink evidence',
                          onPressed: () => _handleUnlink(e),
                        ),
                      if (api != null && _unlinking)
                        const Padding(
                          padding: EdgeInsets.all(4),
                          child: SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(strokeWidth: 1.5),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 5),
                  Text(
                    '${e.role} · linked by ${e.linkedBy}'
                    '${e.matchScore != null ? " at ${e.matchScore!.toStringAsFixed(2)}" : ""}',
                    style: const TextStyle(
                        fontSize: 10.5,
                        fontFamily: VaultType.mono,
                        color: VaultColors.faint),
                  ),
                  if (e.refs.isNotEmpty) ...[
                    const SizedBox(height: 5),
                    Wrap(
                      spacing: 10,
                      runSpacing: 3,
                      children: e.refs.entries.map((r) {
                        final isShared = shared.contains(r.value);
                        return Text(
                          '${r.key}=${r.value}',
                          style: TextStyle(
                            fontSize: 10.5,
                            fontFamily: VaultType.mono,
                            fontWeight: isShared ? FontWeight.w700 : FontWeight.w400,
                            color: isShared ? VaultColors.ok : VaultColors.faint,
                          ),
                        );
                      }).toList(),
                    ),
                  ],
                ]),
              ),
            )),

        // ── correctable fields (work order 03 §P3) ───────────────────────────
        // Read-only provenance text is kept as the fallback: without an API
        // client there is nothing to write to, and showing dead edit affordances
        // would be worse than showing none.
        if (api != null) ...[
          const SizedBox(height: 4),
          const Divider(height: 1, color: VaultColors.line),
          const SizedBox(height: 9),
          const Text('Correct a field',
              style: TextStyle(
                  fontSize: 10.5,
                  fontFamily: VaultType.mono,
                  color: VaultColors.faint)),
          const SizedBox(height: 4),
          EditableField(
            label: 'amount',
            field: 'amount_minor',
            subjectType: 'transactions',
            subjectId: t.id,
            api: api,
            numeric: true,
            value: t.amountMinor.toString(),
            claim: _claims['amount_minor'],
            editable: _claims.editableFields.contains('amount_minor'),
            onSaved: (_) {
              _loadClaims();
              widget.onEdited?.call();
            },
          ),
          EditableField(
            label: 'occurred',
            field: 'occurred_at',
            subjectType: 'transactions',
            subjectId: t.id,
            api: api,
            value: t.occurredAt,
            claim: _claims['occurred_at'],
            editable: _claims.editableFields.contains('occurred_at'),
            onSaved: (_) {
              _loadClaims();
              widget.onEdited?.call();
            },
          ),
          EditableField(
            label: 'counterparty',
            field: 'counterparty',
            subjectType: 'transactions',
            subjectId: t.id,
            api: api,
            value: t.counterparty,
            claim: _claims['counterparty'],
            editable: _claims.editableFields.contains('counterparty'),
            onSaved: (_) {
              _loadClaims();
              widget.onEdited?.call();
            },
          ),
        ] else if (card.provenance.isNotEmpty) ...[
          const SizedBox(height: 4),
          const Divider(height: 1, color: VaultColors.line),
          const SizedBox(height: 9),
          Wrap(
            spacing: 14,
            runSpacing: 3,
            children: card.provenance
                .map((p) => Text(
                      '${p["field"]}=${p["value"]} [${p["source"]}]',
                      style: const TextStyle(
                          fontSize: 10.5,
                          fontFamily: VaultType.mono,
                          color: VaultColors.faint),
                    ))
                .toList(),
          ),
        ],
        const SizedBox(height: 11),
        const Divider(height: 1, color: VaultColors.line),
        const SizedBox(height: 11),
        Text(card.summary,
            style: const TextStyle(fontSize: 12.5, color: VaultColors.ok, height: 1.45)),
      ]),
    );
  }
}
