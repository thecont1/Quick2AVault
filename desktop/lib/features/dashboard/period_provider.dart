/// QAV-FLT-05: Period selection state.
///
/// The user's choice of which time window the dashboard covers. Held in a
/// provider so every widget that depends on the period (snapshot, treemap,
/// transactions, period bar) reads from the same source rather than each
/// holding its own copy.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../widgets/period_bar.dart';

/// Notifier for the selected period.
class PeriodSelectionNotifier extends Notifier<PeriodSelection> {
  @override
  PeriodSelection build() => PeriodSelection.thisMonth;

  void select(PeriodSelection p) => state = p;
}

/// The currently selected period.
final NotifierProvider<PeriodSelectionNotifier, PeriodSelection>
    periodSelectionProvider =
    NotifierProvider<PeriodSelectionNotifier, PeriodSelection>(
  PeriodSelectionNotifier.new,
);

/// The receipts bucket — which hero figure the transaction list explains.
class BucketNotifier extends Notifier<String> {
  @override
  String build() => 'spending';

  void select(String b) => state = b;
}

final NotifierProvider<BucketNotifier, String> bucketProvider =
    NotifierProvider<BucketNotifier, String>(BucketNotifier.new);
