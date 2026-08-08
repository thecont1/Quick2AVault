import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// One transaction: direction, amount, counterparty, double-entry legs, and
/// its evidence documents. The "N DOCS · ONE RUPEE" badge is the payload.
class TxnCard extends StatelessWidget {
  final Txn txn;
  final bool selected;
  final VoidCallback onTap;

  const TxnCard({
    super.key,
    required this.txn,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final dirColor = VaultColors.forDirection(txn.direction);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          decoration: BoxDecoration(
            color: VaultColors.panel,
            border: Border.all(
              color: selected ? VaultColors.transfer : VaultColors.line,
            ),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
              _Tag(text: txn.direction.toUpperCase(), color: dirColor),
              const SizedBox(width: 11),
              // Never wrap or ellipsize the amount — it is the point of the row.
              Text(rupees(txn.amountMinor),
                  maxLines: 1,
                  softWrap: false,
                  style: moneyStyle.copyWith(fontSize: 19, color: VaultColors.ink)),
              if (txn.multiEvidence) ...[
                const SizedBox(width: 10),
                _OneRupeeBadge(count: txn.evidence.length),
              ],
              const Spacer(),
              Flexible(
                child: Text(
                  txn.counterparty ?? 'no counterparty — own accounts',
                  textAlign: TextAlign.right,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13, color: VaultColors.dim),
                ),
              ),
            ]),
            const SizedBox(height: 7),
            Text(
              '${txn.occurredAt} · ${txn.fyKey} · rail=${txn.rail ?? "?"} · ${txn.status}',
              style: const TextStyle(
                  fontSize: 11, color: VaultColors.faint, fontFamily: VaultType.mono),
            ),
            if (txn.legs.isNotEmpty || txn.evidence.isNotEmpty) ...[
              const SizedBox(height: 10),
              const Divider(height: 1, color: VaultColors.line),
              const SizedBox(height: 9),
              ...txn.legs.map((l) => Padding(
                    padding: const EdgeInsets.only(bottom: 3),
                    child: Row(children: [
                      SizedBox(
                        width: 52,
                        child: Text(l.leg,
                            style: TextStyle(
                                fontSize: 11.5,
                                fontFamily: VaultType.mono,
                                color: l.isDebit ? VaultColors.out : VaultColors.income)),
                      ),
                      SizedBox(
                        width: 96,
                        child: Text(rupees(l.amountMinor),
                            style: moneyStyle.copyWith(
                                fontSize: 11.5,
                                fontWeight: FontWeight.w400,
                                color: VaultColors.dim)),
                      ),
                      Expanded(
                        child: Text(l.account,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 11.5,
                                fontFamily: VaultType.mono,
                                color: VaultColors.faint)),
                      ),
                    ]),
                  )),
              ...txn.evidence.map((e) => Padding(
                    padding: const EdgeInsets.only(top: 5),
                    child: Row(children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
                        decoration: BoxDecoration(
                            border: Border.all(color: VaultColors.line)),
                        child: Text(e.role,
                            style: const TextStyle(
                                fontSize: 10,
                                fontFamily: VaultType.mono,
                                color: VaultColors.dim)),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(e.filename,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 11.5, color: VaultColors.faint)),
                      ),
                    ]),
                  )),
            ],
          ]),
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  final String text;
  final Color color;
  const _Tag({required this.text, required this.color});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(border: Border.all(color: color.withValues(alpha: 0.45))),
        child: Text(text,
            style: TextStyle(
                fontSize: 9.5,
                letterSpacing: 0.7,
                fontWeight: FontWeight.w600,
                fontFamily: VaultType.mono,
                color: color)),
      );
}

/// The whole thesis in one badge.
class _OneRupeeBadge extends StatelessWidget {
  final int count;
  const _OneRupeeBadge({required this.count});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
        decoration: BoxDecoration(
          border: Border.all(color: VaultColors.ok.withValues(alpha: 0.5)),
          color: VaultColors.ok.withValues(alpha: 0.08),
        ),
        child: Text('$count DOCS · ONE RUPEE',
            style: const TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w700,
                fontFamily: VaultType.mono,
                color: VaultColors.ok)),
      );
}
