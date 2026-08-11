/// QAV-FLT-04: round-trip and parsing tests for the Freezed-generated models.
///
/// These tests verify that the generated fromJson/toJson preserves the
/// hand-written parsing behaviour that the migration replaced — defaults for
/// missing fields, nullable fields, numeric coercions, date fallbacks,
/// boolean normalization, and domain-specific normalization such as the
/// legacy `added` → `accepted` disposition.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';

void main() {
  group('TreemapSource', () {
    test('parses a full payload', () {
      final s = TreemapSource.fromJson({
        'bucket': 'groceries',
        'amount_minor': 150000,
        'transactions': 3,
      });
      expect(s.bucket, 'groceries');
      expect(s.amountMinor, 150000);
      expect(s.transactions, 3);
    });

    test('defaults when fields are missing', () {
      final s = TreemapSource.fromJson({});
      expect(s.bucket, '');
      expect(s.amountMinor, 0);
      expect(s.transactions, 0);
    });

    test('round-trips through JSON', () {
      final s = TreemapSource.fromJson({
        'bucket': 'rent',
        'amount_minor': 200000,
        'transactions': 1,
      });
      final j = s.toJson();
      expect(TreemapSource.fromJson(j), s);
    });
  });

  group('TreemapData', () {
    test('empty constant has no nodes', () {
      expect(TreemapData.empty.nodes, isEmpty);
      expect(TreemapData.empty.totalMinor, 0);
    });

    test('parses nested nodes with sources', () {
      final d = TreemapData.fromJson({
        'nodes': [
          {
            'id': 'food',
            'label': 'Food',
            'amount_minor': 50000,
            'transactions': 2,
            'known': true,
            'sources': [
              {'bucket': 'groceries', 'amount_minor': 30000, 'transactions': 1},
              {'bucket': 'restaurants', 'amount_minor': 20000, 'transactions': 1},
            ],
          },
        ],
        'total_minor': 50000,
        'raw_buckets': 2,
      });
      expect(d.nodes.length, 1);
      expect(d.nodes.first.label, 'Food');
      expect(d.nodes.first.sources.length, 2);
      expect(d.totalMinor, 50000);
    });
  });

  group('Period', () {
    test('accepts a null map (daemon omits period when no data)', () {
      final p = Period.fromJson(null);
      expect(p.key, 'all');
      expect(p.label, '');
    });

    test('parses a full period', () {
      final p = Period.fromJson({
        'key': 'this_fy',
        'label': 'FY 2024-25',
        'from': '2024-04-01',
        'to': '2025-03-31',
      });
      expect(p.key, 'this_fy');
      expect(p.label, 'FY 2024-25');
      expect(p.from, '2024-04-01');
    });
  });

  group('Periods', () {
    test('empty constant has no months or years', () {
      expect(Periods.empty.months, isEmpty);
      expect(Periods.empty.financialYears, isEmpty);
    });

    test('parses quick items as records', () {
      final p = Periods.fromJson({
        'current_fy': '2024-25',
        'current_month': '2024-07',
        'quick': [
          {'key': 'this_month', 'label': 'This Month'},
          {'key': 'this_fy', 'label': 'This FY'},
        ],
        'months': ['2024-06', '2024-07'],
        'financial_years': ['2023-24', '2024-25'],
      });
      expect(p.quick.length, 2);
      expect(p.quick.first.key, 'this_month');
      expect(p.quick.first.label, 'This Month');
      expect(p.months, ['2024-06', '2024-07']);
    });
  });

  group('Person', () {
    test('normalizes 0/1 integers to booleans', () {
      final p = Person.fromJson({
        'id': 'p1',
        'display_name': 'Alice',
        'is_member': 1,
        'is_owner': 0,
      });
      expect(p.isMember, true);
      expect(p.isOwner, false);
    });

    test('confirmed getter checks status', () {
      expect(
        Person.fromJson({'id': 'p1', 'display_name': 'A', 'status': 'confirmed'})
            .confirmed,
        true,
      );
      expect(
        Person.fromJson({'id': 'p1', 'display_name': 'A', 'status': 'candidate'})
            .confirmed,
        false,
      );
    });
  });

  group('PersonAlias', () {
    test('rejected and proposed getters', () {
      expect(
        PersonAlias.fromJson({
          'id': 1,
          'alias': 'bob',
          'status': 'rejected',
        }).rejected,
        true,
      );
      expect(
        PersonAlias.fromJson({
          'id': 2,
          'alias': 'bob2',
          'status': 'proposed',
        }).proposed,
        true,
      );
    });
  });

  group('Snapshot', () {
    test('empty constant has zero totals', () {
      expect(Snapshot.empty.spendingMinor, 0);
      expect(Snapshot.empty.incomeMinor, 0);
      expect(Snapshot.empty.period.key, 'all');
    });

    test('parses counts from nested map', () {
      final s = Snapshot.fromJson({
        'spending_minor': 100000,
        'income_minor': 200000,
        'counts': {
          'documents': 10,
          'transactions': 25,
          'entities': 5,
          'evidence_links': 15,
        },
        'period': {'key': 'this_fy', 'label': 'FY 24-25'},
      });
      expect(s.spendingMinor, 100000);
      expect(s.documents, 10);
      expect(s.transactions, 25);
      expect(s.period.key, 'this_fy');
    });

    test('naiveMinor sums amount times evidence count', () {
      final s = Snapshot.empty;
      final txns = [
        Txn(id: 't1', direction: 'out', amountMinor: 100, occurredAt: '', fyKey: ''),
        Txn(
          id: 't2',
          direction: 'out',
          amountMinor: 200,
          occurredAt: '',
          fyKey: '',
          evidence: [Evidence(id: 'e1', filename: 'f', role: 'r')],
        ),
      ];
      expect(s.naiveMinor(txns), 100 + 200);
    });
  });

  group('Txn', () {
    test('parses currency as null when empty', () {
      final t = Txn.fromJson({
        'id': 't1',
        'direction': 'out',
        'amount_minor': 500,
        'currency': '',
      });
      expect(t.currency, isNull);
    });

    test('parses currency when present', () {
      final t = Txn.fromJson({
        'id': 't1',
        'direction': 'out',
        'amount_minor': 500,
        'currency': 'USD',
      });
      expect(t.currency, 'USD');
    });

    test('isRefund when reverses_transaction_id is set', () {
      final t = Txn.fromJson({
        'id': 't1',
        'direction': 'in',
        'amount_minor': 500,
        'reverses_transaction_id': 't0',
      });
      expect(t.isRefund, true);
    });

    test('sourceAmount formats with currency', () {
      final t = Txn.fromJson({
        'id': 't1',
        'direction': 'out',
        'amount_minor': 59785,
        'currency': 'USD',
      });
      expect(t.sourceAmount, 'USD 597.85');
    });
  });

  group('IntakeEvent', () {
    test('normalizes legacy "added" to "accepted" disposition', () {
      final e = IntakeEvent.fromJson({
        'id': 1,
        'kind': 'added',
        'filename': 'doc.pdf',
      });
      expect(e.disposition, 'accepted');
    });

    test('keeps "irrelevant" disposition as-is', () {
      final e = IntakeEvent.fromJson({
        'id': 2,
        'kind': 'irrelevant',
        'filename': 'doc.pdf',
      });
      expect(e.disposition, 'irrelevant');
    });

    test('falls back to DateTime.now() on missing created_at', () {
      final e = IntakeEvent.fromJson({'id': 3, 'kind': 'failed'});
      expect(e.createdAt, isNotNull);
      expect(e.createdAt.isBefore(DateTime.now().add(const Duration(seconds: 1))), true);
    });

    test('parses created_at from ISO string', () {
      final e = IntakeEvent.fromJson({
        'id': 4,
        'kind': 'failed',
        'created_at': '2024-07-15T10:30:00Z',
      });
      expect(e.createdAt.year, 2024);
      expect(e.createdAt.month, 7);
    });

    test('needsPassword when processing_state is password_needed', () {
      final e = IntakeEvent.fromJson({
        'id': 5,
        'kind': 'failed',
        'processing_state': 'password_needed',
      });
      expect(e.needsPassword, true);
    });

    test('terminalOutcome returns Completed for complete state', () {
      final e = IntakeEvent.fromJson({
        'id': 6,
        'kind': 'accepted',
        'processing_state': 'complete',
      });
      expect(e.terminalOutcome, 'Completed');
    });

    test('terminalOutcome returns Irrelevant for triaged irrelevant', () {
      final e = IntakeEvent.fromJson({
        'id': 7,
        'kind': 'irrelevant',
        'processing_state': 'triaged',
      });
      expect(e.terminalOutcome, 'Irrelevant');
    });

    test('triageReview accepts both 0/1 and true/false', () {
      expect(
        IntakeEvent.fromJson({'id': 8, 'kind': 'failed', 'triage_review': 1})
            .triageReview,
        true,
      );
      expect(
        IntakeEvent.fromJson({'id': 9, 'kind': 'failed', 'triage_review': true})
            .triageReview,
        true,
      );
      expect(
        IntakeEvent.fromJson({'id': 10, 'kind': 'failed', 'triage_review': 0})
            .triageReview,
        false,
      );
    });
  });

  group('VaultDoc', () {
    test('hasPageImage true for PDF (daemon rasterises server-side)', () {
      final d = VaultDoc.fromJson({
        'id': 'd1',
        'original_filename': 'doc.pdf',
        'ext': 'pdf',
      });
      expect(d.hasPageImage, true);
    });

    test('hasPageImage true for PNG', () {
      final d = VaultDoc.fromJson({
        'id': 'd2',
        'original_filename': 'scan.png',
        'ext': 'png',
      });
      expect(d.hasPageImage, true);
    });

    test('hasPageImage false for EML (no page to render)', () {
      final d = VaultDoc.fromJson({
        'id': 'd3',
        'original_filename': 'email.eml',
        'ext': 'eml',
      });
      expect(d.hasPageImage, false);
    });

    test('analysed getter checks analysedAt', () {
      expect(
        VaultDoc.fromJson({
          'id': 'd4',
          'original_filename': 'f.pdf',
          'analysed_at': '2024-07-15T10:00:00Z',
        }).analysed,
        true,
      );
      expect(
        VaultDoc.fromJson({'id': 'd5', 'original_filename': 'f.pdf'}).analysed,
        false,
      );
    });
  });

  group('PageInfo', () {
    test('none constant has kind "none"', () {
      expect(PageInfo.none.kind, 'none');
      expect(PageInfo.none.hasImage, false);
    });

    test('showPager only when pages > 1 and pager available', () {
      expect(
        PageInfo.fromJson({'kind': 'image', 'pages': 1, 'pager_available': true})
            .showPager,
        false,
      );
      expect(
        PageInfo.fromJson({'kind': 'image', 'pages': 3, 'pager_available': true})
            .showPager,
        true,
      );
      expect(
        PageInfo.fromJson({'kind': 'image', 'pages': 3, 'pager_available': false})
            .showPager,
        false,
      );
    });
  });

  group('DocumentDetail', () {
    test('operator [] accesses effective fields', () {
      final d = DocumentDetail.fromJson({
        'document': {'id': 'doc1'},
        'effective': {
          'vendor_name': {'value': 'Acme Corp', 'source': 'ai', 'status': 'confirmed'},
        },
      });
      expect(d['vendor_name']?.value, 'Acme Corp');
      expect(d['vendor_name']?.source, 'ai');
      expect(d['nonexistent'], isNull);
    });

    test('editableFields parsed as Set', () {
      final d = DocumentDetail.fromJson({
        'document': {},
        'editable_fields': ['vendor_name', 'amount'],
      });
      expect(d.editableFields, {'vendor_name', 'amount'});
    });
  });

  group('HealthStatus', () {
    test('fromJson parses capabilities', () {
      final h = HealthStatus.fromJson({
        'api_version': 'v1',
        'version': '1.2.3',
        'schema_version': 5,
        'capabilities': {'irrelevant': true, 'statements': false},
      });
      expect(h.isReachable, true);
      expect(h.version, '1.2.3');
      expect(h.schemaVersion, 5);
      expect(h.hasCapability('irrelevant'), true);
      expect(h.hasCapability('statements'), false);
      expect(h.isSchemaCompatible(4), true);
      expect(h.isSchemaCompatible(6), false);
    });

    test('unreachable factory', () {
      final h = HealthStatus.unreachable(statusCode: 503, error: 'down');
      expect(h.isReachable, false);
      expect(h.statusCode, 503);
    });
  });

  group('LearningState', () {
    test('empty constant has no questions', () {
      expect(LearningState.empty.questions, isEmpty);
      expect(LearningState.empty.enabled, true);
    });
  });

  group('ClaimSet', () {
    test('operator [] accesses claims', () {
      final c = ClaimSet.fromJson({
        'subject_type': 'documents',
        'subject_id': 'd1',
        'claims': {
          'vendor': {'value': 'Acme', 'source': 'user', 'status': 'confirmed'},
        },
      });
      expect(c['vendor']?.value, 'Acme');
      expect(c['vendor']?.isUser, true);
    });

    test('editableFields parsed as Set from list', () {
      final c = ClaimSet.fromJson({
        'subject_type': 'documents',
        'subject_id': 'd1',
        'editable_fields': ['a', 'b'],
      });
      expect(c.editableFields, {'a', 'b'});
    });
  });

  group('StatementLine', () {
    test('isGap when status created and no_invoice', () {
      final l = StatementLine.fromJson({
        'id': 'l1',
        'status': 'created',
        'transaction_status': 'no_invoice',
      });
      expect(l.isGap, true);
    });

    test('fxOriginal parsed as record', () {
      final l = StatementLine.fromJson({
        'id': 'l2',
        'fx_original': {'amount_minor': 59785, 'currency': 'USD'},
      });
      expect(l.fxOriginal?.amountMinor, 59785);
      expect(l.fxOriginal?.currency, 'USD');
    });
  });

  group('VaultError', () {
    test('maps VaultAuthException to user-facing error', () {
      final e = VaultError.from(VaultAuthException(401, '/v1/snapshot'));
      expect(e.title, 'Authentication failed');
      expect(e.technical, contains('401'));
    });

    test('maps PersonConflict', () {
      final e = VaultError.from(PersonConflict('Name taken'));
      expect(e.title, 'Name already in use');
    });

    test('maps generic socket error', () {
      final e = VaultError.from(Exception('SocketException: connection refused'));
      expect(e.title, 'Daemon unreachable');
    });
  });
}
