import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Month / Year period selector.
///
/// A two-segment control (Month · Year) with arrows to step through whichever
/// unit is selected. Only periods the vault actually has data for are
/// reachable, so a user can never land on an empty November.
///
/// Emits a `PeriodSelection` the caller passes straight to the snapshot API.
class PeriodSelection {
  final String? quick; // this_month | last_month | this_fy | last_fy | all
  final String? month; // YYYY-MM
  final String? fy; // "FY 2026-27"
  const PeriodSelection({this.quick, this.month, this.fy});

  static const thisMonth = PeriodSelection(quick: 'this_month');
  static const thisFy = PeriodSelection(quick: 'this_fy');
}

class PeriodBar extends StatelessWidget {
  final Periods periods;
  final PeriodSelection selection;
  final String label; // resolved label from the daemon, e.g. "July 2026"
  final ValueChanged<PeriodSelection> onChanged;

  const PeriodBar({
    super.key,
    required this.periods,
    required this.selection,
    required this.label,
    required this.onChanged,
  });

  bool get _isMonthMode =>
      selection.month != null ||
      selection.quick == 'this_month' ||
      selection.quick == 'last_month';

  /// The concrete list we're stepping through, newest first.
  List<String> get _values => _isMonthMode ? periods.months : periods.financialYears;

  /// Where we currently sit in that list (-1 if the selection isn't concrete).
  int get _index {
    final current = _isMonthMode
        ? (selection.month ?? _resolveQuickMonth())
        : (selection.fy ?? periods.currentFy);
    return _values.indexOf(current ?? '');
  }

  String? _resolveQuickMonth() {
    if (selection.quick == 'this_month') return periods.currentMonth;
    if (selection.quick == 'last_month') {
      final i = periods.months.indexOf(periods.currentMonth);
      return i >= 0 && i + 1 < periods.months.length ? periods.months[i + 1] : null;
    }
    return null;
  }

  void _step(int delta) {
    final vals = _values;
    if (vals.isEmpty) return;
    // months/FYs arrive newest-first, so "previous" moves forward in the list.
    final next = (_index < 0 ? 0 : _index) + delta;
    if (next < 0 || next >= vals.length) return;
    onChanged(_isMonthMode
        ? PeriodSelection(month: vals[next])
        : PeriodSelection(fy: vals[next]));
  }

  void _switchMode(bool toMonth) {
    if (toMonth) {
      final m = periods.months.isNotEmpty ? periods.months.first : null;
      onChanged(m != null ? PeriodSelection(month: m) : PeriodSelection.thisMonth);
    } else {
      final f = periods.financialYears.isNotEmpty ? periods.financialYears.first : null;
      onChanged(f != null ? PeriodSelection(fy: f) : PeriodSelection.thisFy);
    }
  }

  @override
  Widget build(BuildContext context) {
    final vals = _values;
    final i = _index;
    // Older = further along the newest-first list.
    final canGoOlder = vals.isNotEmpty && (i < 0 || i + 1 < vals.length);
    final canGoNewer = i > 0;

    return Row(children: [
      // ── Month | Year segmented control ──────────────────────────────────
      Container(
        padding: const EdgeInsets.all(2),
        decoration: vaultPill(fill: VaultColors.controlSubtle),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          _Segment(
            label: 'Month',
            selected: _isMonthMode,
            onTap: () => _switchMode(true),
          ),
          _Segment(
            label: 'Year',
            selected: !_isMonthMode,
            onTap: () => _switchMode(false),
          ),
        ]),
      ),
      const SizedBox(width: 10),

      // ── ‹ current period › ──────────────────────────────────────────────
      _Arrow(icon: Icons.chevron_left_rounded, enabled: canGoOlder, onTap: () => _step(1)),
      Expanded(
        child: Center(
          child: Text(
            label.isEmpty ? '—' : label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
                fontSize: 12, fontWeight: FontWeight.w600, color: VaultColors.primary),
          ),
        ),
      ),
      _Arrow(icon: Icons.chevron_right_rounded, enabled: canGoNewer, onTap: () => _step(-1)),
    ]);
  }
}

class _Segment extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _Segment({required this.label, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) => MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              color: selected ? VaultColors.accent.withValues(alpha: 0.16) : Colors.transparent,
              borderRadius: BorderRadius.circular(VaultRadius.pill),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                color: selected ? VaultColors.accent : VaultColors.tertiary,
              ),
            ),
          ),
        ),
      );
}

class _Arrow extends StatelessWidget {
  final IconData icon;
  final bool enabled;
  final VoidCallback onTap;
  const _Arrow({required this.icon, required this.enabled, required this.onTap});

  @override
  Widget build(BuildContext context) => MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        child: GestureDetector(
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
            child: Icon(
              icon,
              size: 20,
              // Disabled arrows stay visible but inert, so the control doesn't
              // reflow when you reach the oldest or newest period.
              color: enabled ? VaultColors.secondary : VaultColors.line,
            ),
          ),
        ),
      );
}
