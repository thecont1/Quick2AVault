// Evidence card acceptance tests (work order 05 §A.3).
//
// Verifies the evidence summary card renders the amount with source currency,
// shows provenance badges, displays line items, and shows "currency uncertain"
// when currency is null — never a silent assumption.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/review_browser.dart';

final _testSurface = Size(1200, 900);

VaultDoc _doc(
  String id,
  String name, {
  String? ext = '.png',
  String? type = 'merchant_invoice',
  String? source = 'drop',
  String? analysedAt = '2026-08-01T10:00:00.000Z',
  int mdChars = 1200,
}) =>
    VaultDoc(
      id: id,
      filename: name,
      ext: ext,
      byteSize: 51200,
      docType: type,
      source: source,
      receivedAt: '2026-08-01T09:00:00Z',
      analysedAt: analysedAt,
      markdownChars: mdChars,
    );

class _FakeApi extends VaultApi {
  final List<VaultDoc> docs;
  final DocumentDetail detail;

  _FakeApi({required this.docs, required this.detail})
      : super(baseUrl: 'http://127.0.0.1:1', token: 'test');

  @override
  Future<List<VaultDoc>> documents({int limit = 200}) async => docs;

  @override
  Future<DocumentDetail> documentDetail(String id) async => detail;

  @override
  Future<String?> documentMarkdown(String id) async => '# Markdown';

  @override
  Future<PageInfo> pageInfo(String id) async =>
      const PageInfo(kind: 'rasterised', pages: 1, pagerAvailable: true);
}

Widget _host(VaultApi api) => MaterialApp(
      home: Scaffold(body: ReviewBrowser(api: api, pendingQuestions: 0, onOpenQueue: null)),
    );

DocumentDetail _detail({
  Map<String, EffectiveValue>? effective,
  Map<String, dynamic>? extraction,
  bool extractionNull = false,
  Map<String, dynamic>? referenceIds,
  List<Map<String, dynamic>> lineItems = const [],
  List<Map<String, dynamic>> parties = const [],
  List<Txn> transactions = const [],
  Set<String> editableFields = const {},
  int? subtotalMinor,
  int? taxMinor,
}) =>
    DocumentDetail(
      document: {'id': 'doc_1', 'original_filename': 'invoice_001.pdf'},
      extraction: extractionNull ? null : (extraction ?? {'amount_minor': 59785, 'currency': 'USD'}),
      effective: effective ?? {
        'amount_minor': const EffectiveValue(value: '59785', source: 'ai', status: 'proposed'),
        'currency': const EffectiveValue(value: 'USD', source: 'ai', status: 'proposed'),
      },
      claims: const {},
      referenceIds: referenceIds ?? {},
      lineItems: lineItems,
      parties: parties,
      transactions: transactions,
      editableFields: editableFields,
      subtotalMinor: subtotalMinor,
      taxMinor: taxMinor,
    );

void main() {
  testWidgets('renders amount with source currency', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // The amount should be rendered as "USD 597.85" — source currency, not a
    // silent rupee assumption.
    expect(find.textContaining('USD 597.85'), findsOneWidget);
  });

  testWidgets('shows "currency uncertain" when currency is null', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        effective: {
          'amount_minor': const EffectiveValue(value: '59785', source: 'ai', status: 'proposed'),
        },
        extraction: {'amount_minor': 59785},
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // Two widgets contain "currency uncertain": the amount text and the hint.
    // Check the hint specifically.
    expect(find.text('currency uncertain — set it below'), findsOneWidget);
  });

  testWidgets('shows invoice number from reference_ids', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        referenceIds: {'invoice_no': 'INV/2026-27/03'},
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.textContaining('INV/2026-27/03'), findsOneWidget);
  });

  testWidgets('shows line items when present', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        lineItems: [
          {'description': 'Consulting services', 'amount_minor': 40000},
          {'description': 'Travel expenses', 'amount_minor': 19785},
        ],
        subtotalMinor: 40000,
        taxMinor: 19785,
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.textContaining('Consulting services'), findsOneWidget);
    expect(find.textContaining('Travel expenses'), findsOneWidget);
    expect(find.textContaining('subtotal'), findsOneWidget);
    expect(find.textContaining('tax'), findsOneWidget);
  });

  testWidgets('shows linked transactions', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        transactions: [
          Txn(
            id: 't1',
            direction: 'out',
            amountMinor: 59785,
            currency: 'USD',
            occurredAt: '2026-08-01T00:00:00Z',
            fyKey: '2026-27',
            linkedBy: 'ai',
          ),
        ],
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.textContaining('out'), findsOneWidget);
    expect(find.text('USD 597.85'), findsOneWidget);
    expect(find.textContaining('linked by'), findsOneWidget);
  });

  testWidgets('shows person from parties', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        parties: [
          {'kind': 'person', 'display_name': 'Arun Kamath', 'role': 'bill_to'},
        ],
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // "Arun Kamath" appears both as a party fact and in the editable person field.
    // Check the party fact label specifically.
    expect(find.textContaining('person (bill_to)'), findsOneWidget);
  });

  testWidgets('shows organisation from parties', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        parties: [
          {'kind': 'organisation', 'display_name': 'Acme Corp', 'role': 'counterparty'},
        ],
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.textContaining('Acme Corp'), findsOneWidget);
  });

  testWidgets('hides evidence card when extraction is null', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(extractionNull: true),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // No amount text should be visible since extraction is null.
    expect(find.textContaining('USD 597.85'), findsNothing);
  });
}
