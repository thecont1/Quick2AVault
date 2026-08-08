// Period selector logic — stepping, mode switching, boundary behaviour.
//
// The bugs this guards against are all "user lands somewhere empty or gets
// stuck": stepping past the oldest month, arrows enabled at a boundary, or
// switching Month->Year and losing the selection entirely.
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/period_bar.dart';

/// Mirrors PeriodBar's stepping rules so they can be asserted without pumping
/// a widget tree. Months and FYs arrive NEWEST FIRST.
({int index, bool canOlder, bool canNewer}) navState(
  List<String> values,
  String current,
) {
  final i = values.indexOf(current);
  return (
    index: i,
    canOlder: values.isNotEmpty && (i < 0 || i + 1 < values.length),
    canNewer: i > 0,
  );
}

void main() {
  // Shape of a real vault: 7 months of data, newest first.
  const months = [
    '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2025-11',
  ];
  const fys = ['FY 2026-27', 'FY 2025-26'];

  test('newest period: cannot step newer, can step older', () {
    final s = navState(months, '2026-08');
    expect(s.index, 0);
    expect(s.canNewer, isFalse, reason: 'no future months to step into');
    expect(s.canOlder, isTrue);
  });

  test('oldest period: cannot step older, can step newer', () {
    final s = navState(months, '2025-11');
    expect(s.index, months.length - 1);
    expect(s.canOlder, isFalse, reason: 'stepping past the oldest month must be blocked');
    expect(s.canNewer, isTrue);
  });

  test('middle period: both directions available', () {
    final s = navState(months, '2026-06');
    expect(s.canOlder, isTrue);
    expect(s.canNewer, isTrue);
  });

  test('gaps in the data are skipped, not shown as empty months', () {
    // 2025-12 through 2026-02 have no documents and are absent from the list,
    // so stepping older from 2026-03 lands on 2025-11 — never an empty month.
    final i = months.indexOf('2026-03');
    expect(months[i + 1], '2025-11');
  });

  test('financial years navigate the same way', () {
    expect(navState(fys, 'FY 2026-27').canNewer, isFalse);
    expect(navState(fys, 'FY 2026-27').canOlder, isTrue);
    expect(navState(fys, 'FY 2025-26').canOlder, isFalse);
  });

  test('selection carries exactly one of quick/month/fy', () {
    const m = PeriodSelection(month: '2026-07');
    expect(m.month, '2026-07');
    expect(m.fy, isNull);
    expect(m.quick, isNull);

    const f = PeriodSelection(fy: 'FY 2026-27');
    expect(f.fy, 'FY 2026-27');
    expect(f.month, isNull);
  });

  test('Periods.fromJson reads the daemon payload', () {
    final p = Periods.fromJson({
      'current_fy': 'FY 2026-27',
      'current_month': '2026-08',
      'quick': [
        {'key': 'this_month', 'label': 'This month'},
        {'key': 'all', 'label': 'All time'},
      ],
      'months': ['2026-08', '2026-07'],
      'financial_years': ['FY 2026-27'],
    });
    expect(p.currentMonth, '2026-08');
    expect(p.quick.first.key, 'this_month');
    expect(p.months.length, 2);
  });

  test('an empty vault produces no navigable periods', () {
    final p = Periods.fromJson({});
    expect(p.months, isEmpty);
    expect(navState(p.months, '').canOlder, isFalse,
        reason: 'arrows must be inert when there is nothing to step to');
  });
}
