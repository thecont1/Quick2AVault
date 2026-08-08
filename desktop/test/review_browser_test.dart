// The Review tab must let you inspect documents, not just answer questions.
//
// Before this, Review WAS the Learning-Mode queue: there was no way to look at
// a document, see what was extracted, or read the converted text. These tests
// pin the browser's contract so that capability cannot silently regress again.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/review_browser.dart';

VaultDoc _doc(
  String id,
  String name, {
  String? ext = '.png',
  String? type = 'invoice',
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
      receivedAt: '2026-08-01T09:00:00.000Z',
      analysedAt: analysedAt,
      markdownChars: mdChars,
    );

/// A VaultApi that serves canned documents. Subclassing keeps the widget under
/// test unchanged — no injection seam invented purely for testing.
class _FakeApi extends VaultApi {
  final List<VaultDoc> docs;
  final String? markdown;
  int markdownCalls = 0;

  _FakeApi({required this.docs, this.markdown})
      : super(baseUrl: 'http://127.0.0.1:1', token: 'test');

  @override
  Future<List<VaultDoc>> documents({int limit = 200}) async => docs;

  @override
  Future<String?> documentMarkdown(String id) async {
    markdownCalls++;
    return markdown;
  }
}

Widget _host(VaultApi api, {int pending = 0, VoidCallback? onQueue}) => MaterialApp(
      home: Scaffold(
        body: ReviewBrowser(
          api: api,
          pendingQuestions: pending,
          onOpenQueue: onQueue,
        ),
      ),
    );

void main() {
  testWidgets('the document list renders and the newest is selected', (tester) async {
    final api = _FakeApi(docs: [
      _doc('d1', 'newest-invoice.png'),
      _doc('d2', 'older-receipt.png'),
    ]);
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.text('newest-invoice.png'), findsWidgets);
    expect(find.text('older-receipt.png'), findsOneWidget);
    // The header states the count rather than making the user infer it.
    expect(find.text('2 documents'), findsOneWidget);
  });

  testWidgets('search narrows the list and says so honestly', (tester) async {
    final api = _FakeApi(docs: [
      _doc('d1', 'swiggy-invoice.png'),
      _doc('d2', 'airtel-receipt.png'),
      _doc('d3', 'amazon-invoice.png'),
    ]);
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'swiggy');
    await tester.pumpAndSettle();

    // "1 of 3", not a bare "1": a shrinking list otherwise reads as data loss.
    expect(find.text('1 of 3'), findsOneWidget);
    expect(find.text('airtel-receipt.png'), findsNothing);
  });

  testWidgets('search matches doc type and source, not only filename',
      (tester) async {
    final api = _FakeApi(docs: [
      _doc('d1', 'aaa.png', type: 'contract_note', source: 'gmail'),
      _doc('d2', 'bbb.png', type: 'invoice', source: 'drop'),
    ]);
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'gmail');
    await tester.pumpAndSettle();
    expect(find.text('1 of 2'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'contract');
    await tester.pumpAndSettle();
    expect(find.text('1 of 2'), findsOneWidget);
  });

  testWidgets('the Markdown toggle fetches text only when asked', (tester) async {
    final api = _FakeApi(
      docs: [_doc('d1', 'invoice.png')],
      markdown: '# Invoice\n\nTotal: 2810',
    );
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // Lazy by default: opening the tab must not pull text for every document.
    expect(api.markdownCalls, 0);

    await tester.tap(find.text('Markdown'));
    await tester.pumpAndSettle();

    expect(api.markdownCalls, 1);
    expect(find.textContaining('Total: 2810'), findsOneWidget);
  });

  testWidgets('a document with no markdown disables the toggle', (tester) async {
    // Disabled rather than hidden: a control that vanishes between documents is
    // more confusing than one that greys out.
    final api = _FakeApi(docs: [_doc('d1', 'scan.png', mdChars: 0)]);
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Markdown'));
    await tester.pumpAndSettle();

    // No fetch, and the pane stays on the document.
    expect(api.markdownCalls, 0);
  });

  testWidgets('a PDF says it has no inline preview instead of showing a broken one',
      (tester) async {
    // Flutter cannot rasterise PDFs without a plugin. Being explicit beats an
    // empty grey box with a zoom cursor that magnifies nothing.
    final api = _FakeApi(docs: [_doc('d1', 'statement.pdf', ext: '.pdf')]);
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.textContaining('No inline preview for .pdf'), findsOneWidget);
    expect(find.textContaining('Switch to Markdown'), findsOneWidget);
  });

  testWidgets('an unanalysed document is visibly distinguished', (tester) async {
    // An unanalysed document contributes to NO total, so the list must not make
    // it look equivalent to an analysed one.
    final api = _FakeApi(docs: [
      _doc('d1', 'pending.png', analysedAt: null),
      _doc('d2', 'done.png'),
    ]);
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.byTooltip('Not analysed yet'), findsOneWidget);
    expect(find.byTooltip('Analysed'), findsOneWidget);
  });

  testWidgets('the Learning-Mode queue stays reachable', (tester) async {
    // The queue used to BE this tab. It must not become unreachable now that
    // the browser is the default surface.
    var opened = false;
    final api = _FakeApi(docs: [_doc('d1', 'x.png')]);
    await tester.pumpWidget(
      _host(api, pending: 4, onQueue: () => opened = true),
    );
    await tester.pumpAndSettle();

    expect(find.text('4 to teach'), findsOneWidget);
    await tester.tap(find.text('4 to teach'));
    await tester.pumpAndSettle();
    expect(opened, isTrue);
  });

  testWidgets('with no pending questions the queue button is absent',
      (tester) async {
    final api = _FakeApi(docs: [_doc('d1', 'x.png')]);
    await tester.pumpWidget(_host(api, pending: 0, onQueue: () {}));
    await tester.pumpAndSettle();
    expect(find.textContaining('to teach'), findsNothing);
  });

  testWidgets('an empty vault does not render an error', (tester) async {
    final api = _FakeApi(docs: const []);
    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();
    expect(find.text('No document selected'), findsOneWidget);
    expect(find.text('0 documents'), findsOneWidget);
  });
}
