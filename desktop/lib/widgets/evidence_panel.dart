import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// The "prove it" surface. Every document backing one rupee, with the
/// reference IDs that appear on MORE THAN ONE of them highlighted — those are
/// the join keys the matcher used.
class EvidencePanel extends StatelessWidget {
  final EvidenceCard card;
  const EvidencePanel({super.key, required this.card});

  @override
  Widget build(BuildContext context) {
    final shared = card.sharedRefValues;
    final t = card.transaction;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: VaultColors.panel,
        border: Border.all(color: VaultColors.line),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(
          'Evidence · ${rupees(t.amountMinor)} · ${t.counterparty ?? "transfer"}',
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
                  Text(e.filename,
                      style: const TextStyle(fontSize: 12, color: VaultColors.ink)),
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
        if (card.provenance.isNotEmpty) ...[
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
