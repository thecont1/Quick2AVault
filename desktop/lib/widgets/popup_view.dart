import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';
import 'period_bar.dart';
import 'treemap.dart';

/// The menubar popup: a calm 420x620 panel. Glance-value only — totals, the
/// last few transactions, and what needs attention. Anything deeper opens the
/// full window.
class PopupView extends StatelessWidget {
  final Snapshot snapshot;
  final Periods periods;
  final PeriodSelection selection;
  final ValueChanged<PeriodSelection> onPeriodChanged;
  final List<Txn> txns;
  final List<VaultEvent> feed;
  final bool connected;
  final VoidCallback onOpenFull;
  final VoidCallback onQuit;
  final VoidCallback onSetup;
  final VoidCallback onReview;
  final VoidCallback onRefresh;
  final VoidCallback onToggleLearning;
  final bool learningOn;
  final int reviewCount;
  /// Spending by category for the same period as the snapshot. Defaults to
  /// empty so the band simply does not render before the first load.
  final TreemapData treemap;
  /// Non-null when the daemon rejected our token. The totals are then
  /// placeholders, and showing them as Rs 0 would read as an empty vault.
  final String? authError;

  const PopupView({
    super.key,
    required this.snapshot,
    required this.periods,
    required this.selection,
    required this.onPeriodChanged,
    required this.txns,
    required this.feed,
    required this.connected,
    required this.onOpenFull,
    required this.onQuit,
    required this.onSetup,
    required this.onReview,
    required this.onRefresh,
    required this.onToggleLearning,
    this.learningOn = true,
    this.reviewCount = 0,
    this.treemap = TreemapData.empty,
    this.authError,
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
        _Header(
          connected: connected,
          busy: busy,
          learningOn: learningOn,
          reviewCount: reviewCount,
          onSetup: onSetup,
          onReview: onReview,
          onOpenFull: onOpenFull,
          onRefresh: onRefresh,
          onToggleLearning: onToggleLearning,
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 2),
          child: PeriodBar(
            periods: periods,
            selection: selection,
            label: snapshot.period.label,
            onChanged: onPeriodChanged,
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
          child: _MoneyTriple(snapshot: snapshot),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
          child: _TransferNote(snapshot: snapshot),
        ),
        if (authError != null) _AuthBanner(message: authError!),
        const Divider(height: 1, color: VaultColors.line),
        Expanded(
          child: recent.isEmpty
              ? const _Empty()
              : ListView(
                  padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                  children: [
                    // Where the money went, above the individual transactions —
                    // the same data as the viewer's treemap, but a single
                    // proportional band. A squarified treemap needs area to be
                    // comparable by eye, and 420px of panel does not have it;
                    // one stacked bar keeps area == money honest at this size.
                    if (treemap.nodes.isNotEmpty) ...[
                      const _Label('WHERE IT WENT'),
                      const SizedBox(height: 8),
                      TreemapBand(
                        nodes: treemap.nodes,
                        totalMinor: treemap.totalMinor,
                      ),
                      const SizedBox(height: 14),
                    ],
                    // Say what this list actually is. "RECENT" alone left the
                    // rule invisible: it is the newest few transactions IN THE
                    // SELECTED PERIOD, capped at 4, with the rest in the full
                    // window. Without the count the list looked arbitrarily
                    // truncated.
                    _Label(txns.length > recent.length
                        ? 'RECENT · ${recent.length} of ${txns.length} this period'
                        : 'RECENT · ${txns.length} this period'),
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
  final bool learningOn;
  final int reviewCount;
  final VoidCallback onSetup;
  final VoidCallback onReview;
  final VoidCallback onOpenFull;
  final VoidCallback onRefresh;
  final VoidCallback onToggleLearning;
  const _Header({
    required this.connected,
    required this.busy,
    required this.learningOn,
    required this.reviewCount,
    required this.onSetup,
    required this.onReview,
    required this.onOpenFull,
    required this.onRefresh,
    required this.onToggleLearning,
  });

  @override
  Widget build(BuildContext context) => Padding(
        // Top padding clears the macOS traffic-light buttons, which float
        // over the frameless popup's top-left corner.
        padding: const EdgeInsets.fromLTRB(18, 34, 10, 6),
        child: Row(children: [
          const Text('Your Money',
              style: TextStyle(
                  fontFamily: displayFont,
                  fontSize: 22,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.5,
                  color: VaultColors.primary)),
          const Spacer(),
          // Review queue, with a count badge when something needs attention.
          _IconButton(
            icon: Icons.assignment_outlined,
            tooltip: 'Review queue',
            onTap: onReview,
            badge: reviewCount,
          ),
          _IconButton(
            icon: Icons.description_outlined,
            tooltip: 'Documents',
            onTap: onOpenFull,
          ),
          // Learning Mode — the graduation cap from the reference, tinted
          // green while it's on.
          _IconButton(
            icon: Icons.school_outlined,
            tooltip: learningOn ? 'Learning is on' : 'Learning is off',
            onTap: onToggleLearning,
            highlighted: learningOn,
          ),
          _IconButton(
            icon: Icons.refresh_rounded,
            tooltip: connected ? 'Live' : 'Reconnecting',
            onTap: onRefresh,
            spinning: busy,
          ),
          _IconButton(icon: Icons.settings_outlined, tooltip: 'Setup', onTap: onSetup),
        ]),
      );
}

/// Income · Spending · Investments as stacked tinted cards, matching the
/// reference design: saturated heading, document count beneath, and a large
/// right-aligned figure.
class _MoneyTriple extends StatelessWidget {
  final Snapshot snapshot;
  const _MoneyTriple({required this.snapshot});

  @override
  Widget build(BuildContext context) => Column(children: [
        _MoneyCard(
          label: 'Income',
          minor: snapshot.incomeMinor,
          fill: VaultColors.incomeFill,
          border: VaultColors.incomeBorder,
          ink: VaultColors.incomeInk,
          documents: snapshot.incomeDocs,
        ),
        const SizedBox(height: 9),
        _MoneyCard(
          label: 'Spending',
          minor: snapshot.spendingMinor,
          fill: VaultColors.spendFill,
          border: VaultColors.spendBorder,
          ink: VaultColors.spendInk,
          documents: snapshot.spendingDocs,
        ),
        const SizedBox(height: 9),
        _MoneyCard(
          label: 'Investments',
          minor: snapshot.investmentsMinor,
          fill: VaultColors.investFill,
          border: VaultColors.investBorder,
          ink: VaultColors.investInk,
          documents: snapshot.investmentDocs,
        ),
      ]);
}

class _MoneyCard extends StatelessWidget {
  final String label;
  final int minor;
  final Color fill;
  final Color border;
  final Color ink;
  final int documents;

  const _MoneyCard({
    required this.label,
    required this.minor,
    required this.fill,
    required this.border,
    required this.ink,
    required this.documents,
  });

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        decoration: vaultCard(fill: fill, border: border),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            // Label column takes only what it needs, so the figure can hold
            // the right edge of the card rather than floating beside the text.
            Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label,
                    style: TextStyle(
                        fontFamily: displayFont,
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.2,
                        color: ink)),
                const SizedBox(height: 2),
                Text(
                  '$documents document${documents == 1 ? '' : 's'} processed',
                  style: TextStyle(fontSize: 11, color: ink.withValues(alpha: 0.65)),
                ),
              ],
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Align(
                alignment: Alignment.centerRight,
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerRight,
                  child: Text(
                    rupeesWhole(minor),
                    maxLines: 1,
                    softWrap: false,
                    textAlign: TextAlign.right,
                    style: moneyStyle.copyWith(fontSize: 24, color: ink),
                  ),
                ),
              ),
            ),
          ],
        ),
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
  final int badge;
  final bool highlighted;
  final bool spinning;
  const _IconButton({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.badge = 0,
    this.highlighted = false,
    this.spinning = false,
  });

  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: onTap,
            child: Stack(clipBehavior: Clip.none, children: [
              Container(
                margin: const EdgeInsets.symmetric(horizontal: 2),
                padding: const EdgeInsets.all(7),
                decoration: highlighted
                    ? BoxDecoration(
                        color: VaultColors.learning.withValues(alpha: 0.18),
                        shape: BoxShape.circle)
                    : null,
                child: spinning
                    ? const SizedBox(
                        width: 17, height: 17,
                        child: CircularProgressIndicator(
                            strokeWidth: 1.8, color: VaultColors.accent))
                    : Icon(icon,
                        size: 17,
                        color: highlighted
                            ? VaultColors.learning
                            : VaultColors.secondary),
              ),
              if (badge > 0)
                Positioned(
                  right: 0, top: -2,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                    constraints: const BoxConstraints(minWidth: 15),
                    decoration: BoxDecoration(
                      color: VaultColors.primary,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    alignment: Alignment.center,
                    // '$badge', NOT '\$badge'. The escaped form printed the
                    // literal text "$badge" in the review indicator instead of
                    // interpolating the pending-review count.
                    child: Text('$badge',
                        style: const TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                            color: Colors.white)),
                  ),
                ),
            ]),
          ),
        ),
      );
}

/// Shown instead of letting an auth failure masquerade as an empty vault.
///
/// This existed because the app rendered Rs 0 for every total when the daemon
/// returned 401, which is indistinguishable from real data loss and reads as
/// "all my data is gone". Zero is a legitimate value; "I could not read your
/// vault" is not zero.
/// A banner for "the numbers below are not what you asked for".
///
/// It USED to ignore its `message` and hardcode an auth-specific sentence, so
/// any other fault — a dead daemon, a stale period — would have been reported
/// to the user as a rejected token. The message now actually renders.
class _AuthBanner extends StatelessWidget {
  final String message;
  const _AuthBanner({required this.message});

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        color: const Color(0xFFFDF2F2),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Padding(
            padding: EdgeInsets.only(top: 1),
            child: Icon(Icons.warning_amber_rounded,
                size: 14, color: Color(0xFFB42318)),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                  fontSize: 11.5, color: Color(0xFFB42318), height: 1.35),
            ),
          ),
        ]),
      );
}
