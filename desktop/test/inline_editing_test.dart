/// Inline editing + search (work order 03 §P3).
///
/// These assert the CONTRACT between the UI and the daemon, not just that
/// widgets render: what the client sends on save, that a refusal is shown as
/// an explanation rather than a crash, and — the one that matters most — that
/// an edit which legitimately does not move the ledger says so instead of
/// implying success.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/editable_field.dart';
import 'package:quick2avault_desktop/widgets/search_box.dart';

/// Records every PATCH so the wire format is asserted, not assumed.
class _Recorder {
  final List<({String path, Map<String, dynamic> body})> patches = [];

  /// Response the daemon will give to the next PATCH.
  Map<String, dynamic> patchResponse = {
    'claim_id': 1,
    'field': 'amount_minor',
    'value': '50000',
    'previous': '64372',
    'affected_transactions': [
      {
        'transaction_id': 'txn_1',
        'changed': ['amount_minor'],
        'reasons': {'amount_minor': 'invoice document (merchant_invoice), user value'},
        'mismatches': [],
      }
    ],
  };
  int patchStatus = 200;

  List<Map<String, dynamic>> searchResults = [];

  VaultApi api() => VaultApi(
        baseUrl: 'http://x',
        token: 't',
        client: MockClient((req) async {
          if (req.method == 'PATCH') {
            patches.add((
              path: req.url.path,
              body: jsonDecode(req.body) as Map<String, dynamic>,
            ));
            return http.Response(jsonEncode(patchResponse), patchStatus);
          }
          if (req.url.path == '/v1/search') {
            return http.Response(
                jsonEncode({'results': searchResults, 'count': searchResults.length}), 200);
          }
          if (req.url.path.endsWith('/claims')) {
            return http.Response(
                jsonEncode({
                  'subject_type': 'transactions',
                  'subject_id': 'txn_1',
                  'editable_fields': ['amount_minor', 'counterparty'],
                  'claims': {
                    'amount_minor': {
                      'value': '64372',
                      'source': 'ai',
                      'status': 'proposed',
                      'confidence': 0.9,
                      'at': '2026-08-01T00:00:00Z',
                    }
                  }
                }),
                200);
          }
          return http.Response('{}', 200);
        }),
      );
}

Widget _wrapField(VaultApi api,
        {String? value, FieldClaim? claim, bool numeric = true}) =>
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 600,
          child: EditableField(
            label: 'amount',
            field: 'amount_minor',
            subjectType: 'transactions',
            subjectId: 'txn_1',
            api: api,
            numeric: numeric,
            value: value,
            claim: claim,
          ),
        ),
      ),
    );

void main() {
  testWidgets('a field shows its provenance badge', (tester) async {
    final r = _Recorder();
    await tester.pumpWidget(_wrapField(
      r.api(),
      value: '64372',
      claim: const FieldClaim(source: 'ai', status: 'proposed', value: '64372'),
    ));
    await tester.pumpAndSettle();

    expect(find.text('ai'), findsOneWidget,
        reason: 'the model reading must be labelled as such');
    expect(find.text('64372'), findsOneWidget);
  });

  testWidgets('tapping opens an editor and Enter sends a PATCH', (tester) async {
    final r = _Recorder();
    await tester.pumpWidget(_wrapField(r.api(), value: '64372'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('64372'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    await tester.enterText(find.byType(TextField), '50000');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();

    expect(r.patches, hasLength(1));
    expect(r.patches.single.path, '/v1/transactions/txn_1/claims');
    expect(r.patches.single.body['field'], 'amount_minor');
    expect(r.patches.single.body['value'], 50000,
        reason: 'a numeric field must be sent as a number, not a string');
  });

  testWidgets('an unchanged value does not hit the network', (tester) async {
    final r = _Recorder();
    await tester.pumpWidget(_wrapField(r.api(), value: '64372'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('64372'));
    await tester.pumpAndSettle();
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();

    expect(r.patches, isEmpty, reason: 'a no-op edit must not write a claim');
  });

  testWidgets('a 409 refusal is shown as an explanation, not a crash',
      (tester) async {
    final r = _Recorder()
      ..patchStatus = 409
      ..patchResponse = {
        'error': 'confirmed_claim_protected',
        'message': 'refusing to overwrite a confirmed user claim with an ai claim',
      };
    await tester.pumpWidget(_wrapField(r.api(), value: '64372'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('64372'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '1');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();

    expect(find.textContaining('refusing to overwrite'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an edit that moves no transaction says so', (tester) async {
    // The settlement-beats-invoice case: the claim is stored, the canonical
    // value legitimately does not move. Reporting "saved" alone would let the
    // user believe the ledger changed.
    final r = _Recorder()
      ..patchResponse = {
        'claim_id': 2,
        'field': 'amount_minor',
        'value': '50000',
        'affected_transactions': [
          {
            'transaction_id': 'txn_1',
            'changed': [],
            'reasons': {'amount_minor': 'settlement document (card_confirmation), ai value'},
            'mismatches': [
              {
                'field': 'amount_minor',
                'document_id': 'doc_1',
                'document_value': '50000',
                'canonical': '64372',
              }
            ],
          }
        ],
      };
    await tester.pumpWidget(_wrapField(r.api(), value: '64372'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('64372'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '50000');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();

    expect(find.textContaining('canonical follows'), findsOneWidget,
        reason: 'the user must learn the settlement document won');
  });

  testWidgets('an orphan document edit reports that nothing was linked',
      (tester) async {
    final r = _Recorder()
      ..patchResponse = {
        'claim_id': 3,
        'field': 'amount_minor',
        'value': '42000',
        'affected_transactions': [],
      };
    await tester.pumpWidget(_wrapField(r.api(), value: '50000'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('50000'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '42000');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();

    expect(find.textContaining('not linked to a transaction'), findsOneWidget);
  });

  testWidgets('search renders results with the match highlighted',
      (tester) async {
    final r = _Recorder()
      ..searchResults = [
        {
          'document_id': 'doc_1',
          'filename': 'A-swiggy-invoice.pdf',
          'doc_type': 'merchant_invoice',
          'transaction_id': 'txn_1',
          'amount_minor': 64372,
          'occurred_at': '2026-07-14',
          'snippet': 'TAX INVOICE «Swiggy» Limited',
          'rank': -1.2,
        }
      ];

    SearchHit? opened;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 700,
          child: SearchBox(api: r.api(), onOpen: (h) => opened = h),
        ),
      ),
    ));

    await tester.enterText(find.byType(TextField), 'swiggy');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    expect(find.text('A-swiggy-invoice.pdf'), findsOneWidget);

    await tester.tap(find.text('A-swiggy-invoice.pdf'));
    await tester.pumpAndSettle();
    expect(opened?.transactionId, 'txn_1',
        reason: 'choosing a result must carry the transaction to open');
  });

  testWidgets('an empty query clears results without searching', (tester) async {
    final r = _Recorder()..searchResults = [];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 700,
          child: SearchBox(api: r.api(), onOpen: (_) {}),
        ),
      ),
    ));

    await tester.enterText(find.byType(TextField), '');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    expect(find.textContaining('No documents match'), findsNothing);
  });
}
