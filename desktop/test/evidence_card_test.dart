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
}) => VaultDoc(
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
  Future<List<AuditEntry>> audit(String subjectId, {int limit = 50}) async =>
      const [];

  @override
  Future<String?> documentMarkdown(String id) async => '# Markdown';

  @override
  Future<PageInfo> pageInfo(String id) async =>
      const PageInfo(kind: 'rasterised', pages: 1, pagerAvailable: true);
}

Widget _host(VaultApi api) => MaterialApp(
  home: Scaffold(body: ReviewBrowser(api: api)),
);

Future<void> _reveal(WidgetTester tester, Finder finder) async {
  final detailScroll = find
      .descendant(
        of: find.byKey(const ValueKey('document-detail-doc_1')),
        matching: find.byType(Scrollable),
      )
      .first;
  await tester.scrollUntilVisible(finder, 250, scrollable: detailScroll);
  await tester.pumpAndSettle();
}

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
}) => DocumentDetail(
  document: {'id': 'doc_1', 'original_filename': 'invoice_001.pdf'},
  extraction: extractionNull
      ? null
      : (extraction ?? {'amount_minor': 59785, 'currency': 'USD'}),
  effective:
      effective ??
      {
        'amount_minor': const EffectiveValue(
          value: '59785',
          source: 'ai',
          status: 'proposed',
        ),
        'currency': const EffectiveValue(
          value: 'USD',
          source: 'ai',
          status: 'proposed',
        ),
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

  testWidgets('shows "currency uncertain" when currency is null', (
    tester,
  ) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        effective: {
          'amount_minor': const EffectiveValue(
            value: '59785',
            source: 'ai',
            status: 'proposed',
          ),
        },
        extraction: {'amount_minor': 59785},
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // The Glaze impact headline must preserve uncertainty instead of silently
    // treating an unlabelled amount as rupees.
    expect(find.textContaining('597.85 (currency uncertain)'), findsOneWidget);
  });

  testWidgets('shows invoice number from reference_ids', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(referenceIds: {'invoice_no': 'INV/2026-27/03'}),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();
    await _reveal(tester, find.textContaining('INV/2026-27/03'));

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
    await _reveal(tester, find.textContaining('Consulting services'));

    expect(find.textContaining('Consulting services'), findsOneWidget);
    expect(find.textContaining('Travel expenses'), findsOneWidget);
    await _reveal(tester, find.text('Subtotal'));
    expect(find.text('Subtotal'), findsOneWidget);
    expect(find.text('Tax'), findsOneWidget);
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
    await _reveal(tester, find.text('Linked transaction (out)'));

    expect(find.text('Linked transaction (out)'), findsOneWidget);
    expect(find.textContaining('USD 597.85 · linked by ai'), findsOneWidget);
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
    await _reveal(tester, find.text('Arun Kamath'));

    expect(find.text('Arun Kamath'), findsOneWidget);
    expect(find.text('Counterparty'), findsOneWidget);
  });

  testWidgets('shows organisation from parties', (tester) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(
        parties: [
          {
            'kind': 'organisation',
            'display_name': 'Acme Corp',
            'role': 'counterparty',
          },
        ],
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();
    await _reveal(tester, find.text('Acme Corp'));

    expect(find.text('Acme Corp'), findsOneWidget);
  });

  testWidgets('keeps resolved claims reviewable when extraction is null', (
    tester,
  ) async {
    tester.view.physicalSize = _testSurface;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final api = _FakeApi(
      docs: [_doc('doc_1', 'invoice_001.pdf')],
      detail: _detail(extractionNull: true),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // Effective claims may be user-confirmed or rule-derived independently of
    // the latest extraction row. The wired Glaze panel must not hide them.
    expect(find.textContaining('USD 597.85'), findsOneWidget);
    expect(find.text('Financial impact'), findsOneWidget);
  });
}
