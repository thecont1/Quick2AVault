import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';
import 'evidence_panel.dart';
import 'hero_row.dart';
import 'treemap.dart';
import 'txn_card.dart';

/// The ledger: hero totals, where the money went, and the transaction list
/// with inline evidence.
///
/// Extracted from main.dart when every surface became a tab in the full
/// window. It is deliberately a dumb widget — all state lives in the shell so
/// switching tabs never refetches or loses the selected transaction.
class LedgerTab extends StatelessWidget {
  final Snapshot snapshot;
  final TreemapData treemap;
  final List<Txn> txns;
  final String? selectedId;
  final EvidenceCard? card;
  final void Function(Txn) onSelect;

  const LedgerTab({
    super.key,
    required this.snapshot,
    required this.treemap,
    required this.txns,
    required this.selectedId,
    required this.card,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(28, 20, 20, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          HeroRow(snapshot: snapshot, txns: txns),
          const SizedBox(height: 22),
          // Where the money went. Sits directly under the hero row because it
          // decomposes the Spending figure shown there — same period, total.
          const _SectionLabel('Where it went'),
          const SizedBox(height: 10),
          SizedBox(
            height: 260,
            child: Treemap(
              nodes: treemap.nodes,
              totalMinor: treemap.totalMinor,
            ),
          ),
          if (treemap.rawBuckets > treemap.nodes.length)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '${treemap.rawBuckets} raw categories folded into '
                '${treemap.nodes.length}',
                style: const TextStyle(fontSize: 11, color: Color(0xFF8A9099)),
              ),
            ),
          const SizedBox(height: 22),
          const _SectionLabel('Transactions'),
          const SizedBox(height: 10),
          if (txns.isEmpty)
            const _EmptyState()
          else
            // Evidence opens INLINE, directly beneath the transaction it
            // belongs to. Rendering it after the whole list forced a scroll to
            // the bottom and broke the link between claim and proof.
            ...txns.map((t) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TxnCard(
                        txn: t,
                        selected: selectedId == t.id,
                        onTap: () => onSelect(t),
                      ),
                      if (selectedId == t.id && card != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 8, left: 14),
                          child: EvidencePanel(card: card!),
                        ),
                    ],
                  ),
                )),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: const TextStyle(
          fontSize: 10.5,
          letterSpacing: 0.9,
          fontWeight: FontWeight.w700,
          color: VaultColors.faint,
        ),
      );
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 40),
        alignment: Alignment.center,
        child: const Text(
          'No transactions in this period.\n'
          'Drop a document anywhere in this window to add one.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, height: 1.6, color: VaultColors.dim),
        ),
      );
}
