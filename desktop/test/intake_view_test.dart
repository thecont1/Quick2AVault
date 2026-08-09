// Work order 06 — Irrelevant view and intake feed tests.
//
// Verifies the Irrelevant view renders triaged-irrelevant items with the §9
// message, offers Restore, and that the feed rail distinguishes all intake
// dispositions rather than showing generic "processed".
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/irrelevant_view.dart';
import 'package:quick2avault_desktop/widgets/feed_rail.dart';

IntakeEvent _irr(
  String filename, {
  int id = 1,
  String reason = 'Personal/non-financial note content with no document signal.',
  String reasonCode = 'personal_note',
  String source = 'folder',
}) =>
    IntakeEvent(
      id: id,
      kind: 'irrelevant',
      filename: filename,
      source: source,
      reason: reason,
      reasonCode: reasonCode,
      processingState: 'archived',
      triageReview: false,
      createdAt: DateTime.parse('2026-08-10T01:00:00Z'),
    );

class _FakeApi extends VaultApi {
  final List<IntakeEvent> _irrelevant;
  int restoreCalls = 0;

  _FakeApi({required List<IntakeEvent> irrelevant})
      : _irrelevant = irrelevant,
        super(baseUrl: 'http://127.0.0.1:1', token: 'test');

  @override
  Future<List<IntakeEvent>> irrelevantItems({int limit = 200}) async => _irrelevant;

  @override
  Future<Map<String, dynamic>> restoreIntake(int id) async {
    restoreCalls++;
    return {'disposition': 'accepted', 'intake_id': id};
  }
}

void main() {
  testWidgets('Irrelevant view shows the §9 kept-safely message', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: IrrelevantView(api: _FakeApi(irrelevant: [_irr('recipe.txt')])),
      ),
    ));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('kept safely, excluded from financial analysis'),
      findsOneWidget,
    );
  });

  testWidgets('Irrelevant view lists each irrelevant file with its reason', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: IrrelevantView(
          api: _FakeApi(irrelevant: [
            _irr('recipe.txt', id: 1, reason: 'Recipe content, no financial signal.'),
            _irr('IMG_4523.jpg', id: 2, reasonCode: 'family_photo',
                reason: 'Family/personal photo filename with no document signal.'),
          ]),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('recipe.txt'), findsOneWidget);
    expect(find.text('IMG_4523.jpg'), findsOneWidget);
    expect(find.textContaining('Recipe content'), findsOneWidget);
    expect(find.textContaining('Family/personal photo'), findsOneWidget);
  });

  testWidgets('Restore button calls the API and shows a snackbar', (tester) async {
    final api = _FakeApi(irrelevant: [_irr('recipe.txt', id: 7)]);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: IrrelevantView(api: api)),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Restore'));
    await tester.pumpAndSettle();

    expect(api.restoreCalls, 1);
    expect(find.textContaining('Restored'), findsOneWidget);
  });

  testWidgets('Irrelevant view empty state explains the tab', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: IrrelevantView(api: _FakeApi(irrelevant: const []))),
    ));
    await tester.pumpAndSettle();
    expect(find.text('No irrelevant items'), findsOneWidget);
    expect(find.textContaining('Files triaged as irrelevant'), findsOneWidget);
  });

  testWidgets('feed rail distinguishes accepted vs irrelevant vs duplicate', (tester) async {
    final events = [
      VaultEvent('IntakeAccepted', {
        'filename': 'invoice.pdf',
        'triage_review': false,
      }),
      VaultEvent('IntakeIrrelevant', {
        'filename': 'recipe.txt',
        'reason_code': 'personal_note',
      }),
      VaultEvent('IntakeDuplicate', {
        'filename': 'copy.pdf',
        'matched_document_id': 'doc_abcdef12',
      }),
      VaultEvent('IntakeFailed', {
        'filename': 'broken.pdf',
        'reason': 'archive verification failed',
      }),
    ];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 400,
          child: FeedRail(events: events, connected: true),
        ),
      ),
    ));
    await tester.pumpAndSettle();

    // Each disposition has its own prefix so the user can tell them apart.
    expect(find.textContaining('accepted  invoice.pdf'), findsOneWidget);
    expect(find.textContaining('irrelevant  recipe.txt'), findsOneWidget);
    expect(find.textContaining('duplicate  copy.pdf'), findsOneWidget);
    expect(find.textContaining('failed  broken.pdf'), findsOneWidget);
  });

  testWidgets('feed rail shows review flag on accepted-with-review items', (tester) async {
    final events = [
      VaultEvent('IntakeAccepted', {
        'filename': 'scan.jpg',
        'triage_review': true,
      }),
    ];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 400,
          child: FeedRail(events: events, connected: true),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('review'), findsOneWidget);
  });

  test('IntakeEvent.disposition normalises legacy "added" to "accepted"', () {
    final e = IntakeEvent(
      id: 1,
      kind: 'added',
      filename: 'x.pdf',
      source: 'folder',
      processingState: 'queued',
      triageReview: false,
      createdAt: DateTime.now(),
    );
    expect(e.disposition, 'accepted');
  });
}
