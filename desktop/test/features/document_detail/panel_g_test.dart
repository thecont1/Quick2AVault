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
    expect(fixture.text('document_type'), 'Tax Invoice'); // 6
    expect(fixture.text('vendor'), 'PetaSight Inc.'); // 7
    expect(fixture.text('document_date'), '2026-04-01'); // 8
    expect(fixture.text('financial_year'), 'FY 2026-27'); // 9
    expect(fixture.text('currency_conversion'), '1691.31 USD'); // 10
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

Future<void> _scrollTo(WidgetTester tester, String text) async {
  final target = find.text(text);
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
