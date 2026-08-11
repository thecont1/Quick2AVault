/// QAV-FLT-05: Dashboard data providers — snapshot, treemap, transactions,
/// and periods.
///
/// Each provider depends on [periodSelectionProvider] (and [bucketProvider]
/// for transactions) so changing the period automatically refetches all
/// dashboard data. The providers use [AsyncNotifier] to expose loading,
/// ready, and error states explicitly.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api.dart';
import '../../core/providers.dart';
import '../connection/status_provider.dart';
import 'period_provider.dart';

// ─── Snapshot ───────────────────────────────────────────────────────────

/// Notifier for the financial snapshot.
class SnapshotNotifier extends AsyncNotifier<Snapshot> {
  @override
  Future<Snapshot> build() async {
    final api = ref.watch(vaultApiProvider);
    final logger = ref.watch(appLoggerProvider);
    final period = ref.watch(periodSelectionProvider);
    try {
      final snap = await api.snapshot(
        period: period.quick,
        month: period.month,
        fy: period.fy,
      );
      ref.read(connectionStatusProvider.notifier).markConnected();
      return snap;
    } on VaultAuthException {
      logger.w('Snapshot: auth rejected', error: 'VaultAuthException');
      ref.read(connectionStatusProvider.notifier).markAuthError();
      rethrow;
    } catch (e, st) {
      logger.w('Snapshot: fetch failed', error: e, stackTrace: st);
      ref.read(connectionStatusProvider.notifier).markDegraded(
            period.month ?? period.fy ?? period.quick ?? 'the selected period',
          );
      rethrow;
    }
  }

  /// Force a refetch.
  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<SnapshotNotifier, Snapshot>
    snapshotProvider =
    AsyncNotifierProvider<SnapshotNotifier, Snapshot>(
  SnapshotNotifier.new,
);

// ─── Treemap ────────────────────────────────────────────────────────────

class TreemapNotifier extends AsyncNotifier<TreemapData> {
  @override
  Future<TreemapData> build() async {
    final api = ref.watch(vaultApiProvider);
    final period = ref.watch(periodSelectionProvider);
    return api.treemap(
      period: period.quick,
      month: period.month,
      fy: period.fy,
    );
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<TreemapNotifier, TreemapData>
    treemapProvider =
    AsyncNotifierProvider<TreemapNotifier, TreemapData>(
  TreemapNotifier.new,
);

// ─── Transactions ───────────────────────────────────────────────────────

class TransactionsNotifier extends AsyncNotifier<List<Txn>> {
  @override
  Future<List<Txn>> build() async {
    final api = ref.watch(vaultApiProvider);
    final period = ref.watch(periodSelectionProvider);
    final bucket = ref.watch(bucketProvider);
    return api.transactions(
      period: period.quick,
      month: period.month,
      fy: period.fy,
      bucket: bucket,
    );
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<TransactionsNotifier, List<Txn>>
    transactionsProvider =
    AsyncNotifierProvider<TransactionsNotifier, List<Txn>>(
  TransactionsNotifier.new,
);

// ─── Periods ────────────────────────────────────────────────────────────

class PeriodsNotifier extends AsyncNotifier<Periods> {
  @override
  Future<Periods> build() async {
    final api = ref.watch(vaultApiProvider);
    return api.periods();
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<PeriodsNotifier, Periods>
    periodsProvider =
    AsyncNotifierProvider<PeriodsNotifier, Periods>(
  PeriodsNotifier.new,
);
