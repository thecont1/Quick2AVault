import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/review/document_detail.dart';

import '_fixture.dart';

late PanelFixture fixture;

void main() {
  setUpAll(() => fixture = loadFixture('panel_g'));
  setUp(() {
    TestWidgetsFlutterBinding
            .instance
            .platformDispatcher
            .implicitView!
            .devicePixelRatio =
        1;
  });

  testWidgets('Layer 1 — Fixture G deterministic Glaze contract', (
    tester,
  ) async {
    await _pump(tester);
    expect(find.text('Document'), findsOneWidget); // 1
    expect(find.text('Markdown'), findsOneWidget); // 2
    expect(
      find.text('Income of ${fixture.text('amount')}.'),
      findsOneWidget,
    ); // 3
    expect(find.text('Income'), findsOneWidget); // 4
    expect(find.text(fixture.text('person')), findsWidgets); // 5
    await _scrollTo(tester, 'Tax Invoice');
    expect(find.byWidgetPredicate((w) => w is SelectableText && w.data == 'Tax Invoice'), findsOneWidget); // 6
    await _scrollTo(tester, 'PetaSight Inc.');
    expect(find.byWidgetPredicate((w) => w is SelectableText && w.data == 'PetaSight Inc.'), findsOneWidget); // 7
    await _scrollTo(tester, '2026-04-01');
    expect(find.byWidgetPredicate((w) => w is SelectableText && w.data == '2026-04-01'), findsOneWidget); // 8
    await _scrollTo(tester, 'FY 2026-27');
    expect(find.byWidgetPredicate((w) => w is SelectableText && w.data == 'FY 2026-27'), findsOneWidget); // 9
    await _scrollTo(tester, 'Currency conversion');
    expect(find.textContaining('1691.31 USD'), findsOneWidget); // 10
    // Scroll back to top so the line items are within the lazy build window.
    for (var i = 0; i < 30; i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, 180));
      await tester.pump();
    }
    for (final line in fixture.list('lines')) {
      await _scrollTo(tester, line['description'] as String);
      expect(find.text(line['description'] as String), findsOneWidget); // 11+
    }
    await _scrollTo(tester, 'Identity reasoning');
    expect(find.text('Identity reasoning'), findsOneWidget);
    expect(
      find.text('Audit trail (${fixture.list('audit_entries').length})'),
      findsOneWidget,
    );
    await _scrollTo(tester, 'Open original');
    for (final action in const [
      'Open original',
      'Open Markdown',
      'Reprocess',
      'Remove from active',
      'Delete permanently',
    ]) {
      await _scrollTo(tester, action);
      expect(find.text(action), findsOneWidget);
    }
  });

  testWidgets('Layer 2 — Fixture G advisory golden diff', (tester) async {
    await _pump(tester);
    await expectLater(
      find.byType(DocumentDetailPanel),
      matchesGoldenFile('../../../../fixtures/golden/panel-G.png'),
    );
  });
}

Finder _findText(String text) => find.byWidgetPredicate(
      (w) => (w is Text && w.data == text) || (w is SelectableText && w.data == text),
    );

Future<void> _scrollTo(WidgetTester tester, String text) async {
  final target = _findText(text);
  if (target.evaluate().isNotEmpty) {
    await tester.ensureVisible(target.first);
  } else {
    for (
      var attempt = 0;
      attempt < 20 && target.evaluate().isEmpty;
      attempt++
    ) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -180));
      await tester.pump();
    }
    if (target.evaluate().isNotEmpty) await tester.ensureVisible(target.first);
  }
  await tester.pump();
}

Future<void> _pump(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1124, 1012);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: DocumentDetailPanel(document: fixture.toDocument())),
    ),
  );
  await tester.pump();
}
