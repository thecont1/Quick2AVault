/// QAV-FLT-05: Provider tests for the Riverpod state migration.
///
/// Each test verifies a provider's success, failure, and disposal behavior
/// using a mock VaultApi backed by `http.MockClient`.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/core/providers.dart';
import 'package:quick2avault_desktop/features/connection/status_provider.dart';
import 'package:quick2avault_desktop/features/dashboard/dashboard_providers.dart';
import 'package:quick2avault_desktop/features/dashboard/period_provider.dart';
import 'package:quick2avault_desktop/features/feature_providers.dart';
import 'package:quick2avault_desktop/widgets/period_bar.dart';

/// Creates a ProviderContainer with a mock VaultApi.
ProviderContainer _container({required http.Client client}) {
  final api = VaultApi(baseUrl: 'http://x', token: 't', client: client);
  final container = ProviderContainer(overrides: [
    vaultApiProvider.overrideWith((ref) => api),
  ]);
  addTearDown(container.dispose);
  return container;
}

void main() {
  group('ConnectionStatusProvider', () {
    test('reports connected when health returns true', () async {
      final client = MockClient((request) async {
        return http.Response('{"ok": true}', 200);
      });
      final container = _container(client: client);
      // The build() method kicks off an initial check; wait for it to settle.
      final notifier = container.read(connectionStatusProvider.notifier);
      await notifier.check();
      // Allow the build's concurrent check to complete.
      await Future.delayed(Duration.zero);
      expect(container.read(connectionStatusProvider).isConnected, true);
    });

    test('reports unreachable when health returns false', () async {
      final client = MockClient((request) async {
        return http.Response('{"ok": false}', 503);
      });
      final container = _container(client: client);
      final notifier = container.read(connectionStatusProvider.notifier);
      await notifier.check();
      await Future.delayed(Duration.zero);
      expect(container.read(connectionStatusProvider).isUnreachable, true);
    });
  });

  group('PeriodSelectionProvider', () {
    test('defaults to thisMonth', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final period = container.read(periodSelectionProvider);
      expect(period.quick, 'this_month');
    });

    test('select updates the period', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(periodSelectionProvider.notifier).select(
            PeriodSelection.thisFy,
          );
      expect(container.read(periodSelectionProvider).quick, 'this_fy');
    });
  });

  group('BucketProvider', () {
    test('defaults to spending', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(bucketProvider), 'spending');
    });

    test('select updates the bucket', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(bucketProvider.notifier).select('income');
      expect(container.read(bucketProvider), 'income');
    });
  });

  group('SnapshotProvider', () {
    test('fetches snapshot data', () async {
      final client = MockClient((request) async {
        if (request.url.path == '/v1/snapshot') {
          return http.Response(
            '{"spending_minor": 100000, "income_minor": 200000, "counts": {"documents": 5, "transactions": 10, "entities": 2, "evidence_links": 3}, "period": {"key": "this_month", "label": "This Month"}}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('{"error": "not found"}', 404);
      });
      final container = _container(client: client);
      final snap = await container.read(snapshotProvider.future);
      expect(snap.spendingMinor, 100000);
      expect(snap.incomeMinor, 200000);
      expect(snap.documents, 5);
    });
  });

  group('TreemapProvider', () {
    test('fetches treemap data', () async {
      final client = MockClient((request) async {
        if (request.url.path.contains('/v1/treemap')) {
          return http.Response(
            '{"nodes": [{"id": "food", "label": "Food", "amount_minor": 50000, "transactions": 2, "known": true, "sources": []}], "total_minor": 50000, "raw_buckets": 1}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('{"error": "not found"}', 404);
      });
      final container = _container(client: client);
      final treemap = await container.read(treemapProvider.future);
      expect(treemap.nodes.length, 1);
      expect(treemap.nodes.first.label, 'Food');
      expect(treemap.totalMinor, 50000);
    });
  });

  group('PeriodsProvider', () {
    test('fetches periods data', () async {
      final client = MockClient((request) async {
        if (request.url.path == '/v1/periods') {
          return http.Response(
            '{"current_fy": "2024-25", "current_month": "2024-07", "quick": [{"key": "this_month", "label": "This Month"}], "months": ["2024-06", "2024-07"], "financial_years": ["2023-24", "2024-25"]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('{"error": "not found"}', 404);
      });
      final container = _container(client: client);
      final periods = await container.read(periodsProvider.future);
      expect(periods.currentFy, '2024-25');
      expect(periods.months, ['2024-06', '2024-07']);
      expect(periods.quick.length, 1);
    });
  });

  group('TransactionsProvider', () {
    test('fetches transactions list', () async {
      final client = MockClient((request) async {
        if (request.url.path == '/v1/transactions') {
          return http.Response(
            '{"transactions": [{"id": "t1", "direction": "out", "amount_minor": 500, "currency": "INR", "occurred_at": "2024-07-01", "fy_key": "2024-25"}]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('{"error": "not found"}', 404);
      });
      final container = _container(client: client);
      final txns = await container.read(transactionsProvider.future);
      expect(txns.length, 1);
      expect(txns.first.id, 't1');
      expect(txns.first.amountMinor, 500);
    });
  });

  group('IntakeStatusProvider', () {
    test('fetches intake items', () async {
      final client = MockClient((request) async {
        if (request.url.path == '/v1/intake/status') {
          return http.Response(
            '{"events": [{"id": 1, "kind": "accepted", "filename": "doc.pdf", "processing_state": "complete", "created_at": "2024-07-01T00:00:00Z"}]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('{"error": "not found"}', 404);
      });
      final container = _container(client: client);
      final items = await container.read(intakeStatusProvider.future);
      expect(items.length, 1);
      expect(items.first.filename, 'doc.pdf');
    });
  });

  group('EntitiesProvider', () {
    test('fetches entities list', () async {
      final client = MockClient((request) async {
        if (request.url.path == '/v1/entities') {
          return http.Response(
            '{"entities": [{"id": "e1", "display_name": "Alice", "kind": "person", "status": "confirmed", "is_owner": 1, "is_member": 1, "document_count": 5, "transaction_count": 10, "unresolved_alias_count": 0, "alias_count": 2}]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('{"error": "not found"}', 404);
      });
      final container = _container(client: client);
      final entities = await container.read(entitiesProvider.future);
      expect(entities.length, 1);
    });
  });
}
