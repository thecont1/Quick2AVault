import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// The menubar popup: a calm 420x620 panel. Glance-value only — totals, the
/// last few transactions, and what needs attention. Anything deeper opens the
/// full window.
class PopupView extends StatelessWidget {
  final Snapshot snapshot;
  final List<Txn> txns;
  final List<VaultEvent> feed;
  final bool connected;
  final VoidCallback onOpenFull;
  final VoidCallback onQuit;
  final VoidCallback onSetup;

  const PopupView({
    super.key,
    required this.snapshot,
    required this.txns,
    required this.feed,
    required this.connected,
    required this.onOpenFull,
    required this.onQuit,
    required this.onSetup,
  });

  @override
  Widget build(BuildContext context) {
    final recent = txns.take(4).toList();
    final busy = feed.isNotEmpty &&
        feed.first.type != 'AnalysisComplete' &&
        DateTime.now().difference(feed.first.at).inSeconds < 6;

    return Container(
      decoration: BoxDecoration(
        color: VaultColors.popover,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: VaultColors.line),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _Header(connected: connected, busy: busy, onQuit: onQuit, onSetup: onSetup),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: _MoneyTriple(snapshot: snapshot),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
          child: _TransferNote(snapshot: snapshot),
        ),
        const Divider(height: 1, color: VaultColors.line),
        Expanded(
          child: recent.isEmpty
              ? const _Empty()
              : ListView(
                  padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                  children: [
                    const _Label('RECENT'),
                    const SizedBox(height: 8),
                    ...recent.map((t) => _MiniTxn(txn: t)),
                  ],
                ),
        ),
        const Divider(height: 1, color: VaultColors.line),
        _Footer(onOpenFull: onOpenFull),
      ]),
    );
  }
}

class _Header extends StatelessWidget {
  final bool connected;
  final bool busy;
  final VoidCallback onQuit;
  final VoidCallback onSetup;
  const _Header({
    required this.connected,
    required this.busy,
    required this.onQuit,
    required this.onSetup,
  });

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 8, 0),
        child: Row(children: [
          // The brand mark. Falls back to a tinted ₹ disc if the asset is
          // missing, so the header never renders as a broken-image box.
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: Image.asset(
              'assets/logo.png',
              width: 26,
              height: 26,
              filterQuality: FilterQuality.medium,
              errorBuilder: (_, _, _) => Container(
                width: 26, height: 26,
                decoration: BoxDecoration(
                  color: VaultColors.accent.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(6),
                ),
                alignment: Alignment.center,
                child: const Text('₹',
                    style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: VaultColors.accent)),
              ),
            ),
          ),
          const SizedBox(width: 9),
          const Text('Quick2A Vault',
              style: TextStyle(
                  fontSize: 13.5, fontWeight: FontWeight.w600, color: VaultColors.primary)),
          const Spacer(),
          if (busy)
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: SizedBox(
                width: 10, height: 10,
                child: CircularProgressIndicator(
                    strokeWidth: 1.6, color: VaultColors.accent),
              ),
            ),
          Container(
            width: 6, height: 6,
            decoration: BoxDecoration(
              color: connected ? VaultColors.ok : VaultColors.warn,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 6),
          _IconButton(icon: Icons.tune_rounded, tooltip: 'Setup', onTap: onSetup),
          _IconButton(icon: Icons.close_rounded, tooltip: 'Quit', onTap: onQuit),
        ]),
      );
}

/// Income · Expenses · Investments — the three numbers that matter, side by
/// side. Investments are deliberately NOT folded into Expenses: buying shares
/// is not consumption, and mixing them makes a portfolio look like spending.
class _MoneyTriple extends StatelessWidget {
  final Snapshot snapshot;
  const _MoneyTriple({required this.snapshot});

  @override
  Widget build(BuildContext context) => Container(
        decoration: vaultCard(fill: VaultColors.controlSubtle40),
        child: IntrinsicHeight(
          child: Row(children: [
            Expanded(
              child: _Money(
                label: 'INCOME',
                minor: snapshot.incomeMinor,
                color: VaultColors.income,
              ),
            ),
            const VerticalDivider(width: 1, color: VaultColors.line),
            Expanded(
              child: _Money(
                label: 'EXPENSES',
                minor: snapshot.spendingMinor,
                color: VaultColors.out,
              ),
            ),
            const VerticalDivider(width: 1, color: VaultColors.line),
            Expanded(
              child: _Money(
                label: 'INVESTED',
                minor: snapshot.investmentsMinor,
                color: VaultColors.transfer,
              ),
            ),
          ]),
        ),
      );
}

class _Money extends StatelessWidget {
  final String label;
  final int minor;
  final Color color;
  const _Money({required this.label, required this.minor, required this.color});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(11, 13, 11, 13),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label,
              style: const TextStyle(
                  fontSize: 8.5,
                  letterSpacing: 0.9,
                  fontWeight: FontWeight.w700,
                  color: VaultColors.tertiary)),
          const SizedBox(height: 7),
          // Money must never wrap mid-number; scale down instead.
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(rupees(minor),
                maxLines: 1,
                softWrap: false,
                style: moneyStyle.copyWith(fontSize: 16, color: color)),
          ),
        ]),
      );
}

class _TransferNote extends StatelessWidget {
  final Snapshot snapshot;
  const _TransferNote({required this.snapshot});

  @override
  Widget build(BuildContext context) {
    if (snapshot.transfersMinor == 0) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: vaultCard(fill: VaultColors.controlSubtle40),
      child: Row(children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
          decoration: vaultPill(
            border: VaultColors.transfer.withValues(alpha: 0.4),
            fill: VaultColors.transfer.withValues(alpha: 0.10),
          ),
          child: const Text('TRANSFERS',
              style: TextStyle(
                  fontSize: 8.5, letterSpacing: 0.6,
                  fontWeight: FontWeight.w700, color: VaultColors.transfer)),
        ),
        const SizedBox(width: 10),
        Text(rupees(snapshot.transfersMinor),
            style: moneyStyle.copyWith(fontSize: 13, color: VaultColors.secondary)),
        const SizedBox(width: 8),
        const Expanded(
          child: Text('not spending',
              style: TextStyle(fontSize: 11, color: VaultColors.tertiary)),
        ),
      ]),
    );
  }
}

class _MiniTxn extends StatelessWidget {
  final Txn txn;
  const _MiniTxn({required this.txn});

  @override
  Widget build(BuildContext context) {
    final c = VaultColors.forDirection(txn.direction);
    return Container(
      margin: const EdgeInsets.only(bottom: 7),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: vaultCard(),
      child: Row(children: [
        Container(width: 6, height: 6,
            decoration: BoxDecoration(color: c, shape: BoxShape.circle)),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(txn.counterparty ?? 'own accounts',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, color: VaultColors.primary)),
            const SizedBox(height: 3),
            Row(children: [
              Text(txn.occurredAt,
                  style: const TextStyle(
                      fontSize: 10.5, fontFamily: VaultType.mono,
                      color: VaultColors.tertiary)),
              if (txn.multiEvidence) ...[
                const SizedBox(width: 7),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: vaultPill(
                    border: VaultColors.ok.withValues(alpha: 0.45),
                    fill: VaultColors.ok.withValues(alpha: 0.10),
                  ),
                  child: Text('${txn.evidence.length} docs · one rupee',
                      style: const TextStyle(
                          fontSize: 8.5, fontWeight: FontWeight.w700,
                          color: VaultColors.ok)),
                ),
              ],
            ]),
          ]),
        ),
        const SizedBox(width: 8),
        Text(rupees(txn.amountMinor),
            maxLines: 1, softWrap: false,
            style: moneyStyle.copyWith(fontSize: 13.5, color: VaultColors.primary)),
      ]),
    );
  }
}

class _Footer extends StatelessWidget {
  final VoidCallback onOpenFull;
  const _Footer({required this.onOpenFull});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
        child: Row(children: [
          const Expanded(
            child: Text('Drop documents into the watched folder',
                style: TextStyle(fontSize: 11, color: VaultColors.tertiary)),
          ),
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: onOpenFull,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                decoration: vaultPill(
                  border: VaultColors.accent.withValues(alpha: 0.5),
                  fill: VaultColors.accent.withValues(alpha: 0.12),
                ),
                child: const Text('Open Vault',
                    style: TextStyle(
                        fontSize: 11.5, fontWeight: FontWeight.w600,
                        color: VaultColors.accent)),
              ),
            ),
          ),
        ]),
      );
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);
  @override
  Widget build(BuildContext context) => Text(text,
      style: const TextStyle(
          fontSize: 9.5, letterSpacing: 1.0,
          fontWeight: FontWeight.w600, color: VaultColors.tertiary));
}

class _Empty extends StatelessWidget {
  const _Empty();
  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('Nothing yet.\nDrop a document into the watched folder.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: VaultColors.tertiary, height: 1.6)),
        ),
      );
}

class _IconButton extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  const _IconButton({required this.icon, required this.tooltip, required this.onTap});

  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(6),
              child: Icon(icon, size: 15, color: VaultColors.tertiary),
            ),
          ),
        ),
      );
}
