import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// The three heroes plus the argument: what a document-counting tool would
/// have reported, struck through, beside what this vault reports.
class HeroRow extends StatelessWidget {
  final Snapshot snapshot;
  final List<Txn> txns;
  const HeroRow({super.key, required this.snapshot, required this.txns});

  @override
  Widget build(BuildContext context) {
    final naive = snapshot.naiveMinor(txns);
    final showArgument = snapshot.documents > snapshot.transactions;

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        decoration: BoxDecoration(border: Border.all(color: VaultColors.line)),
        child: IntrinsicHeight(
          child: Row(children: [
            Expanded(
              child: _Hero(
                label: 'Spending',
                value: rupees(snapshot.spendingMinor),
                note: 'this financial year',
              ),
            ),
            const VerticalDivider(width: 1, color: VaultColors.line),
            Expanded(
              child: _Hero(
                label: 'Transfers',
                value: rupees(snapshot.transfersMinor),
                note: 'between your own accounts — not spending',
                color: VaultColors.transfer,
              ),
            ),
            const VerticalDivider(width: 1, color: VaultColors.line),
            Expanded(
              child: _Hero(
                label: 'Ledger',
                value: '${snapshot.documents} → ${snapshot.transactions}',
                note: '${snapshot.documents} documents, ${snapshot.transactions} '
                    'transactions, ${snapshot.evidenceLinks} evidence links',
              ),
            ),
          ]),
        ),
      ),
      if (showArgument) ...[
        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          decoration: const BoxDecoration(
            color: VaultColors.panel,
            border: Border(
              left: BorderSide(color: VaultColors.ok, width: 2),
              top: BorderSide(color: VaultColors.line),
              right: BorderSide(color: VaultColors.line),
              bottom: BorderSide(color: VaultColors.line),
            ),
          ),
          child: RichText(
            text: TextSpan(
              style: const TextStyle(fontSize: 13, color: VaultColors.dim, height: 1.5),
              children: [
                TextSpan(
                  text: '${snapshot.documents} documents describe '
                      '${snapshot.transactions} transactions. ',
                  style: const TextStyle(
                      color: VaultColors.ink, fontWeight: FontWeight.w600),
                ),
                const TextSpan(text: 'Counting documents would report '),
                TextSpan(
                  text: rupees(naive),
                  style: const TextStyle(
                    color: VaultColors.faint,
                    decoration: TextDecoration.lineThrough,
                    fontFamily: VaultType.mono,
                  ),
                ),
                const TextSpan(text: ' — this vault reports '),
                TextSpan(
                  text: rupees(snapshot.spendingMinor),
                  style: const TextStyle(
                      color: VaultColors.ink,
                      fontWeight: FontWeight.w600,
                      fontFamily: VaultType.mono),
                ),
                const TextSpan(
                    text: ', because linked evidence is counted once and wallet '
                        'loads are transfers, not spending.'),
              ],
            ),
          ),
        ),
      ],
    ]);
  }
}

class _Hero extends StatelessWidget {
  final String label;
  final String value;
  final String note;
  final Color? color;
  const _Hero({
    required this.label,
    required this.value,
    required this.note,
    this.color,
  });

  @override
  Widget build(BuildContext context) => Container(
        color: VaultColors.panel,
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label.toUpperCase(),
              style: const TextStyle(
                  fontSize: 10.5,
                  letterSpacing: 1.0,
                  color: VaultColors.dim,
                  fontWeight: FontWeight.w600)),
          const SizedBox(height: 9),
          // Money must NEVER wrap mid-number ("₹960." / "09"). At narrow widths
          // we scale the glyphs down instead of breaking the figure.
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              maxLines: 1,
              softWrap: false,
              style: moneyStyle.copyWith(
                  fontSize: 28, color: color ?? VaultColors.ink),
            ),
          ),
          const SizedBox(height: 7),
          Text(note,
              style: const TextStyle(fontSize: 11.5, color: VaultColors.faint, height: 1.4)),
        ]),
      );
}
