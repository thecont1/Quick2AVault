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

  const PopupView({
    super.key,
    required this.snapshot,
    required this.txns,
    required this.feed,
    required this.connected,
    required this.onOpenFull,
    required this.onQuit,
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
        _Header(connected: connected, busy: busy, onQuit: onQuit),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
          child: _SpendCard(snapshot: snapshot),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
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
  const _Header({required this.connected, required this.busy, required this.onQuit});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 10, 0),
        child: Row(children: [
          Container(
            width: 22, height: 22,
            decoration: BoxDecoration(
              color: VaultColors.accent.withValues(alpha: busy ? 0.9 : 0.18),
              shape: BoxShape.circle,
              border: Border.all(color: VaultColors.accent.withValues(alpha: 0.6)),
            ),
            alignment: Alignment.center,
            child: Text('₹',
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: busy ? Colors.white : VaultColors.accent)),
          ),
          const SizedBox(width: 9),
          const Text('Quick2AVault',
              style: TextStyle(
                  fontSize: 13.5, fontWeight: FontWeight.w600, color: VaultColors.primary)),
          const Spacer(),
          Container(
            width: 6, height: 6,
            decoration: BoxDecoration(
              color: connected ? VaultColors.ok : VaultColors.warn,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 10),
          _IconButton(icon: Icons.close_rounded, tooltip: 'Quit', onTap: onQuit),
        ]),
      );
}

class _SpendCard extends StatelessWidget {
  final Snapshot snapshot;
  const _SpendCard({required this.snapshot});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(16, 15, 16, 15),
        decoration: vaultCard(fill: VaultColors.controlSubtle40),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('SPENDING THIS FY',
              style: TextStyle(
                  fontSize: 9.5, letterSpacing: 1.0,
                  fontWeight: FontWeight.w600, color: VaultColors.tertiary)),
          const SizedBox(height: 8),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(rupees(snapshot.spendingMinor),
                maxLines: 1,
                softWrap: false,
                style: moneyStyle.copyWith(fontSize: 32, color: VaultColors.primary)),
          ),
          const SizedBox(height: 6),
          Text(
            '${snapshot.documents} documents → ${snapshot.transactions} transactions',
            style: const TextStyle(fontSize: 11.5, color: VaultColors.tertiary),
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
