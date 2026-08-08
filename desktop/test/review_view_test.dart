// Learning Mode: the review queue.
//
// The bug that started this: onReview and onSetup both set _setup = true, so
// clicking Document Review opened Settings. Worse, there was no review UI at
// all — the daemon asked questions that could not be answered, because the
// Dart client had no answer() or dismiss() method. Learning is the app's
// primary input channel, so an unanswerable queue is not a cosmetic problem.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/review_view.dart';

/// Matches the daemon's real payload — shape verified against the live
/// endpoint, including `rule_id` (not `applied`, which never existed).
Map<String, dynamic> _payload({
  List<Map<String, dynamic>>? questions,
  List<Map<String, dynamic>>? rules,
  bool enabled = true,
  int answered = 0,
}) => {
      'enabled': enabled,
      'budget': 3,
      'questions': questions ?? const [],
      'rules': rules ?? const [],
      'answered': answered,
    };

final _aliasQuestion = {
  'id': 5,
  'question': 'Is "SWIGGY*BLR 4471" the same as Swiggy?',
  'trigger': 'unseen_entity',
  'context': {
    'descriptor': 'SWIGGY*BLR 4471',
    'entity_name': 'Swiggy',
    'document_id': 'doc_abc',
  },
  'options': ['Yes, always', 'No, keep separate'],
  'created_at': '2026-08-08T10:00:00.000Z',
};

/// Captures what the UI actually POSTs, so the rule contract is asserted
/// rather than assumed.
class _Recorder {
  final List<({String path, Map<String, dynamic> body})> posts = [];
  Map<String, dynamic> state;
  _Recorder(this.state);

  VaultApi api() => VaultApi(
        baseUrl: 'http://x',
        token: 't',
        client: MockClient((req) async {
          if (req.method == 'GET' && req.url.path == '/v1/learning') {
            return http.Response(jsonEncode(state), 200);
          }
          if (req.method == 'POST') {
            posts.add((
              path: req.url.path,
              body: jsonDecode(req.body) as Map<String, dynamic>,
            ));
            if (req.url.path == '/v1/learning/answer') {
              return http.Response(jsonEncode({'answered': true, 'rule_id': 1}), 200);
            }
            return http.Response(jsonEncode({'dismissed': true}), 200);
          }
          return http.Response('{}', 200);
        }),
      );
}

Widget _wrap(VaultApi api, {VoidCallback? onChanged}) => MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 900,
          height: 700,
          child: ReviewView(api: api, onClose: () {}, onChanged: onChanged),
        ),
      ),
    );

void main() {
  testWidgets('the question is shown with both strings compared', (tester) async {
    final r = _Recorder(_payload(questions: [_aliasQuestion]));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();

    expect(find.textContaining('the same as Swiggy'), findsOneWidget);
    // The raw descriptor and the resolved name shown side by side, because a
    // long bank string is hard to compare inside a sentence.
    expect(find.text('SWIGGY*BLR 4471'), findsOneWidget);
    expect(find.text('ON THE DOCUMENT'), findsOneWidget);
    expect(find.text('KNOWN AS'), findsOneWidget);
  });

  testWidgets('an affirmative answer creates a DURABLE alias rule', (tester) async {
    final r = _Recorder(_payload(questions: [_aliasQuestion]));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('Yes, always'));
    await tester.pumpAndSettle();

    expect(r.posts.length, 1);
    final p = r.posts.single;
    expect(p.path, '/v1/learning/answer');
    expect(p.body['review_id'], 5);
    // The whole point: the answer must persist as a rule, not fix one row.
    expect(p.body['rule_kind'], 'entity_alias');
    expect(p.body['match_key'], 'SWIGGY*BLR 4471');
    expect(p.body['value'], 'Swiggy');
  });

  testWidgets('a NEGATIVE answer must not create an alias rule', (tester) async {
    // Creating an alias here would teach the exact opposite of what was said.
    final r = _Recorder(_payload(questions: [_aliasQuestion]));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('No, keep separate'));
    await tester.pumpAndSettle();

    final p = r.posts.single;
    expect(p.body['review_id'], 5);
    expect(p.body.containsKey('rule_kind'), isFalse,
        reason: '"No" must never be recorded as an alias');
  });

  testWidgets('each answer states the rule it will create BEFORE the click',
      (tester) async {
    final r = _Recorder(_payload(questions: [_aliasQuestion]));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();

    // These answers shape every future document, so the consequence is shown.
    expect(find.textContaining('Always: SWIGGY*BLR 4471 → Swiggy'), findsOneWidget);
    expect(find.textContaining('Applies to this document only'), findsOneWidget);
  });

  testWidgets('skipping dismisses without teaching anything', (tester) async {
    final r = _Recorder(_payload(questions: [_aliasQuestion]));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('Skip'));
    await tester.pumpAndSettle();

    expect(r.posts.single.path, '/v1/learning/dismiss');
    expect(r.posts.single.body['review_id'], 5);
  });

  testWidgets('answering notifies the caller so the badge updates', (tester) async {
    var notified = 0;
    final r = _Recorder(_payload(questions: [_aliasQuestion]));
    await tester.pumpWidget(_wrap(r.api(), onChanged: () => notified++));
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('Yes, always'));
    await tester.pumpAndSettle();

    expect(notified, 1, reason: 'a stale badge lies about work already done');
  });

  testWidgets('an empty queue says so and shows what was learned', (tester) async {
    final r = _Recorder(_payload(
      answered: 4,
      rules: [
        {'id': 1, 'kind': 'entity_alias', 'match_key': 'SWIGGY*BLR',
         'value': 'Swiggy', 'times_applied': 3},
      ],
    ));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();

    expect(find.text('Nothing to review'), findsOneWidget);
    expect(find.textContaining('4 things'), findsOneWidget);
    // The work must read as cumulative, not endless.
    expect(find.text('WHAT THE VAULT KNOWS'), findsOneWidget);
    expect(find.textContaining('used 3'), findsOneWidget);
  });

  testWidgets('a disabled engine explains itself', (tester) async {
    final r = _Recorder(_payload(enabled: false));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();
    expect(find.text('Learning Mode is off'), findsOneWidget);
  });

  testWidgets('a question with no options is still answerable', (tester) async {
    // Never render a dead end: fall back to yes/no.
    final q = Map<String, dynamic>.from(_aliasQuestion)..['options'] = <String>[];
    final r = _Recorder(_payload(questions: [q]));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();

    expect(find.textContaining('Yes, always'), findsOneWidget);
    expect(find.textContaining('No, keep separate'), findsOneWidget);
  });

  testWidgets('the pending count is visible in the header', (tester) async {
    final q2 = Map<String, dynamic>.from(_aliasQuestion)..['id'] = 6;
    final r = _Recorder(_payload(questions: [_aliasQuestion, q2]));
    await tester.pumpWidget(_wrap(r.api()));
    await tester.pumpAndSettle();
    expect(find.text('2 pending'), findsOneWidget);
  });

  test('LearningState parses the daemon payload, rule_id included', () {
    final s = LearningState.fromJson(_payload(
      questions: [_aliasQuestion],
      rules: [
        {'id': 1, 'kind': 'entity_alias', 'match_key': 'A', 'value': 'B',
         'times_applied': 2},
      ],
      answered: 7,
    ));
    expect(s.questions.single.descriptor, 'SWIGGY*BLR 4471');
    expect(s.questions.single.entityName, 'Swiggy');
    expect(s.questions.single.documentId, 'doc_abc');
    expect(s.rules.single.timesApplied, 2);
    expect(s.answered, 7);
  });
}
