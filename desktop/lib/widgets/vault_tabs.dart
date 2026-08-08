import 'package:flutter/material.dart';

import '../theme.dart';

/// The surfaces a user can reach. One window, one place for everything.
///
/// Before this, Settings / Document Review / People were mutually exclusive
/// full-screen takeovers driven by separate booleans, reachable only from the
/// menubar popup. That made the popup a hidden router: you could not get to
/// Settings from the viewer at all, and two flags could disagree.
enum VaultTab {
  ledger('Ledger', Icons.receipt_long_outlined),
  review('Review', Icons.school_outlined),
  people('People', Icons.people_outline),
  charts('Charts', Icons.insights_outlined),
  settings('Settings', Icons.settings_outlined);

  const VaultTab(this.label, this.icon);
  final String label;
  final IconData icon;
}

/// Horizontal tab bar for the full window.
///
/// Deliberately not Material's TabBar: that couples navigation to a
/// TabController and a PageView, which would rebuild — and therefore refetch —
/// each surface on every switch. These tabs are cheap selectors over state the
/// shell already holds.
class VaultTabBar extends StatelessWidget {
  final VaultTab current;
  final ValueChanged<VaultTab> onChanged;
  /// Pending review questions. Shown as a badge on the Review tab so the queue
  /// is visible from anywhere, not just the popup.
  final int reviewCount;
  /// Tabs that exist but are not built yet, rendered disabled rather than
  /// hidden: a greyed tab is an honest promise, a missing one is a surprise.
  final Set<VaultTab> disabled;

  const VaultTabBar({
    super.key,
    required this.current,
    required this.onChanged,
    this.reviewCount = 0,
    this.disabled = const {},
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: VaultColors.line)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Row(
        children: [
          for (final t in VaultTab.values)
            _Tab(
              tab: t,
              selected: t == current,
              enabled: !disabled.contains(t),
              badge: t == VaultTab.review ? reviewCount : 0,
              onTap: () => onChanged(t),
            ),
        ],
      ),
    );
  }
}

class _Tab extends StatelessWidget {
  final VaultTab tab;
  final bool selected;
  final bool enabled;
  final int badge;
  final VoidCallback onTap;

  const _Tab({
    required this.tab,
    required this.selected,
    required this.enabled,
    required this.badge,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // A disabled tab must be UNMISTAKABLY inert. VaultColors.faint (#8E8E93)
    // sits only ~35 luminance points from dim (#6B6B70), which on screen read
    // as just another enabled tab — the "Charts" tab looked clickable and did
    // nothing. Opacity on top of the lightest grey is the clear signal.
    final fg = !enabled
        ? VaultColors.faint.withValues(alpha: 0.45)
        : selected
            ? VaultColors.accent
            : VaultColors.dim;

    return Semantics(
      button: true,
      selected: selected,
      enabled: enabled,
      label: badge > 0 ? '${tab.label}, $badge pending' : tab.label,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        child: GestureDetector(
          onTap: enabled ? onTap : null,
          behavior: HitTestBehavior.opaque,
          child: Container(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 11),
            margin: const EdgeInsets.only(right: 4),
            decoration: BoxDecoration(
              border: Border(
                // The selected tab is marked by a rule directly under it,
                // touching the bar's own border — the cheapest unambiguous
                // signal, no fill or pill needed.
                bottom: BorderSide(
                  color: selected ? VaultColors.accent : Colors.transparent,
                  width: 2,
                ),
              ),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(tab.icon, size: 15, color: fg),
              const SizedBox(width: 7),
              Text(
                tab.label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                  color: fg,
                ),
              ),
              if (badge > 0) ...[
                const SizedBox(width: 7),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: VaultColors.accent,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    '$badge',
                    style: const TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w700,
                      color: Colors.white,
                    ),
                  ),
                ),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}

/// Placeholder for a tab that is planned but not built.
///
/// Says what it will be and that it is not ready, rather than showing an empty
/// panel the user reads as broken.
class ComingSoon extends StatelessWidget {
  final String title;
  final String detail;
  const ComingSoon({super.key, required this.title, required this.detail});

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(40),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.insights_outlined, size: 32, color: VaultColors.faint),
            const SizedBox(height: 14),
            Text(title,
                style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: VaultColors.ink)),
            const SizedBox(height: 7),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Text(
                detail,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 13, height: 1.55, color: VaultColors.dim),
              ),
            ),
          ]),
        ),
      );
}
