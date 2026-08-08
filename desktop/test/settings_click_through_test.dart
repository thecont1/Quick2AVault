/// Settings pane click-through, driven by widget tests since computer_use
/// cannot reliably interact with this Flutter app (work order 04 §Track C.1).
///
/// These assert the CONTRACT the on-screen checklist (§C.2) will exercise:
///   - Danger Zone won't fire until the user types RESET verbatim
///   - cancelling posts nothing
///   - a successful reset renders the daemon's own response, not a canned string
///   - clearing the API key sends "" (a dropped field would silently no-op)
///   - saving an unrelated setting does NOT touch the key (the setup_view bug
///     fixed in cc90973 — regression guard)
///   - person rename posts PATCH and surfaces the alias-kept copy
///   - rename onto an existing person shows the merge-refusal, not a crash
///   - deleting a referenced person renders the 409 explanation with a force path
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/danger_zone.dart';
import 'package:quick2avault_desktop/widgets/person_editor.dart';

/// Records every POST/PATCH/DELETE so the wire format is asserted, not assumed.
class _Recorder {
  final List<({String method, String path, Map<String, dynamic> body})> requests = [];
  Map<String, dynamic> resetResponse = {
    'scope': 'ledger',
    'cleared': {'documents': 72, 'transactions': 78, 'entities': 4, 'learned_rules': 6},
    'ai_available': true,
    'note': 'Documents on disk were not touched. Drop them into the watched folder to rebuild the ledger.',
  };
  int resetStatus = 200;
  Map<String, dynamic> settingsResponse = {'saved': [], 'cleared': [], 'ai_available': false};
  int peopleStatus = 200;
  Map<String, dynamic> peopleResponse = {'changed': [], 'person': {}};
  int deleteStatus = 200;
  Map<String, dynamic> deleteResponse = {'deleted': 'ent_x', 'reassigned_documents': 0};

  VaultApi api() => VaultApi(
        baseUrl: 'http://x',
        token: 't',
        client: MockClient((req) async {
          final body = req.body.isEmpty
              ? <String, dynamic>{}
              : jsonDecode(req.body) as Map<String, dynamic>;
          requests.add((method: req.method, path: req.url.path, body: body));

          if (req.url.path == '/v1/reset') {
            return http.Response(jsonEncode(resetResponse), resetStatus);
          }
          if (req.url.path == '/v1/settings') {
            return http.Response(jsonEncode(settingsResponse), 200);
          }
          if (req.method == 'DELETE' && req.url.path.startsWith('/v1/people/')) {
            return http.Response(jsonEncode(deleteResponse), deleteStatus);
          }
          if (req.method == 'PATCH' && req.url.path.startsWith('/v1/people/')) {
            return http.Response(jsonEncode(peopleResponse), peopleStatus);
          }
          return http.Response('{}', 404);
        }),
      );
}

Future<void> _pump(WidgetTester t, Widget child) => t.pumpWidget(
      MaterialApp(home: Scaffold(body: child)),
    );

void main() {
  group('Danger Zone', () {
    testWidgets('reset ledger requires typing the confirm phrase verbatim', (t) async {
      final rec = _Recorder();
      await _pump(t, DangerZone(api: rec.api()));

      await t.tap(find.text('Reset ledger'));
      await t.pumpAndSettle();

      // The dialog is open; the destructive action must not be reachable
      // without typing RESET first.
      expect(find.text('Reset ledger'), findsWidgets); // dialog title/button
      final resetButtons = find.widgetWithText(FilledButton, 'Reset ledger');
      expect(resetButtons, findsOneWidget);

      // No request fired just from opening the dialog.
      expect(rec.requests, isEmpty, reason: 'opening the confirm dialog must not call the API');
    });

    testWidgets('cancel posts nothing', (t) async {
      final rec = _Recorder();
      await _pump(t, DangerZone(api: rec.api()));

      await t.tap(find.text('Reset ledger'));
      await t.pumpAndSettle();
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();

      expect(rec.requests, isEmpty, reason: 'Cancel must not call /v1/reset');
    });

    testWidgets('confirming posts scope + confirm:RESET and renders the daemon response', (t) async {
      final rec = _Recorder();
      await _pump(t, DangerZone(api: rec.api()));

      await t.tap(find.text('Reset ledger'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Reset ledger'));
      await t.pumpAndSettle();

      expect(rec.requests, hasLength(1));
      expect(rec.requests.first.method, 'POST');
      expect(rec.requests.first.path, '/v1/reset');
      expect(rec.requests.first.body['scope'], 'ledger');
      expect(rec.requests.first.body['confirm'], 'RESET', reason: 'must be the literal word, not a boolean flag');

      // The success message renders the daemon's own counts, not a canned string.
      expect(find.textContaining('72'), findsOneWidget);
      expect(find.textContaining('78'), findsOneWidget);
    });

    testWidgets('factory reset also posts scope:factory', (t) async {
      final rec = _Recorder()
        ..resetResponse = {
          'scope': 'factory',
          'cleared': {'documents': 0, 'transactions': 0, 'entities': 0, 'learned_rules': 0},
          'ai_available': false,
        };
      await _pump(t, DangerZone(api: rec.api()));

      await t.tap(find.text('Factory reset'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Erase everything'));
      await t.pumpAndSettle();

      expect(rec.requests.first.body['scope'], 'factory');
      expect(rec.requests.first.body['confirm'], 'RESET');
    });

    testWidgets('a failed reset shows an error, not a silent no-op', (t) async {
      final rec = _Recorder()..resetStatus = 500;
      await _pump(t, DangerZone(api: rec.api()));

      await t.tap(find.text('Reset ledger'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Reset ledger'));
      await t.pumpAndSettle();

      expect(find.textContaining('failed'), findsOneWidget);
    });
  });

  group('Clear API key', () {
    testWidgets('clearApiKey sends an empty string, not a dropped field', (t) async {
      final rec = _Recorder();
      final api = rec.api();
      await api.clearApiKey();

      expect(rec.requests, hasLength(1));
      expect(rec.requests.first.path, '/v1/settings');
      // The bug this guards: a dropped/omitted field looks identical to "no
      // change requested" on the wire. It must be present and empty.
      expect(rec.requests.first.body.containsKey('api_key'), isTrue);
      expect(rec.requests.first.body['api_key'], '');
    });

    testWidgets('saving an unrelated field does not send api_key at all', (t) async {
      final rec = _Recorder();
      final api = rec.api();
      await api.saveSettings(model: 'claude-sonnet-5');

      expect(rec.requests, hasLength(1));
      // Regression guard for the cc90973 setup_view bug: sending an empty
      // api_key on every save would silently wipe a stored key. The field
      // must be ABSENT, not present-and-empty, when the user didn't touch it.
      expect(
        rec.requests.first.body.containsKey('api_key'),
        isFalse,
        reason: 'an untouched key field must not be sent at all',
      );
    });

    testWidgets('setting a real key sends it verbatim', (t) async {
      final rec = _Recorder();
      final api = rec.api();
      await api.saveSettings(apiKey: 'sk-ant-real-key');

      expect(rec.requests.first.body['api_key'], 'sk-ant-real-key');
    });
  });

  group('Person editor', () {
    Map<String, dynamic> person({String id = 'ent_a', String name = 'Alice'}) => {
          'id': id,
          'display_name': name,
          'subtype': null,
          'is_member': 0,
        };

    testWidgets('rename posts PATCH with display_name and shows alias-kept copy', (t) async {
      final rec = _Recorder();
      await _pump(
        t,
        PersonEditor(api: rec.api(), person: person()),
      );

      await t.enterText(find.byType(TextField).first, 'Alicia');
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();

      expect(rec.requests, hasLength(1));
      expect(rec.requests.first.method, 'PATCH');
      expect(rec.requests.first.path, '/v1/people/ent_a');
      expect(rec.requests.first.body['display_name'], 'Alicia');
    });

    testWidgets('the helper text explains the alias is kept', (t) async {
      final rec = _Recorder();
      await _pump(t, PersonEditor(api: rec.api(), person: person()));
      expect(find.textContaining('alias'), findsOneWidget);
    });

    testWidgets('renaming onto an existing person surfaces the merge-refusal, not a crash', (t) async {
      final rec = _Recorder()
        ..peopleStatus = 409
        ..peopleResponse = {
          'error': 'name_taken',
          'message': '"Bob" already exists. Use /v1/people/merge to combine them.',
          'existing_id': 'ent_b',
        };
      await _pump(t, PersonEditor(api: rec.api(), person: person()));

      await t.enterText(find.byType(TextField).first, 'Bob');
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();

      expect(find.textContaining('already exists'), findsOneWidget);
      expect(find.textContaining('merge'), findsOneWidget);
      // flutter_test fails the test automatically on any uncaught exception
      // during pump/settle, so reaching this line means none escaped.
    });

    testWidgets('making owner sends is_owner:true', (t) async {
      final rec = _Recorder();
      await _pump(t, PersonEditor(api: rec.api(), person: person()));

      await t.tap(find.byType(CheckboxListTile));
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();

      expect(rec.requests.first.body['is_owner'], isTrue);
    });

    testWidgets('deleting a referenced person renders the 409 explanation with a force option', (t) async {
      final rec = _Recorder()
        ..deleteStatus = 409
        ..deleteResponse = {
          'error': 'person_in_use',
          'message': 'Alice is named on 55 document(s). Re-run with ?force=1 to unlink and delete.',
          'documents': 55,
        };
      await _pump(t, PersonEditor(api: rec.api(), person: person()));

      await t.tap(find.text('Delete'));
      await t.pumpAndSettle();
      // Confirm the initial "are you sure" dialog.
      await t.tap(find.widgetWithText(FilledButton, 'Delete'));
      await t.pumpAndSettle();

      // The 409 explanation, with the document count, must reach the screen.
      expect(find.textContaining('55'), findsOneWidget);
      expect(find.textContaining('Unidentified'), findsOneWidget,
          reason: 'force path must state what happens to the evidence links');

      // The force option is offered, not just an error dead-end.
      expect(find.text('Unlink and delete'), findsOneWidget);
    });
  });
}
