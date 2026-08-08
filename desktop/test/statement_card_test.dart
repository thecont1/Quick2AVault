/// Statement summary card (work order 04 §A.6).
///
/// Asserts the CONTRACT between the UI and /v1/documents/:id/statement:
/// summary numbers render, the gap count is called out distinctly (that is
/// the whole point of the feature), the drill-down list expands on demand,
/// and a non-statement document renders NOTHING rather than an error box —
/// most documents are not statements, and that must not look like a failure.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/statement_card.dart';

VaultApi apiReturning(int status, Map<String, dynamic> body) => VaultApi(
      baseUrl: 'http://x',
      token: 't',
      client: MockClient((req) async => http.Response(jsonEncode(body), status)),
    );

const summaryJson = {
  'document_id': 'doc_stmt',
  'doc_type': 'bank_statement',
  'summary': {'total': 12, 'linked': 8, 'created': 3, 'pending': 1, 'gaps': 2},
  'lines': [
    {
      'id': 'stln_1',
      'line_no': 1,
      'occurred_at': '2026-07-01',
      'raw_descriptor': 'SWIGGY BLR 080',
      'amount_minor': 64372,
      'direction': 'out',
      'balance_after_minor': 9935628,
      'currency': 'INR',
      'fx_original': null,
      'reference_id': null,
      'status': 'linked',
      'transaction_id': 'txn_1',
      'transaction_status': 'evidenced',
      'counterparty_name': 'Swiggy Limited',
    },
    {
      'id': 'stln_2',
      'line_no': 2,
      'occurred_at': '2026-07-05',
      'raw_descriptor': 'UNKNOWN MERCHANT',
      'amount_minor': 99900,
      'direction': 'out',
      'balance_after_minor': null,
      'currency': 'INR',
      'fx_original': null,
      'reference_id': null,
      'status': 'created',
      'transaction_id': 'txn_2',
      'transaction_status': 'no_invoice',
      'counterparty_name': null,
    },
  ],
};

Future<void> pump(WidgetTester t, Widget child) async {
  await t.pumpWidget(MaterialApp(home: Scaffold(body: child)));
  await t.pumpAndSettle();
}

void main() {
  testWidgets('summary numbers render from the daemon response', (t) async {
    final api = apiReturning(200, summaryJson);
    await pump(t, StatementCard(api: api, documentId: 'doc_stmt'));

    expect(find.textContaining('12 lines read'), findsOneWidget);
    expect(find.textContaining('8 linked'), findsOneWidget);
    expect(find.textContaining('3 created'), findsOneWidget);
  });

  testWidgets('gaps are called out with the "no invoice" reason, not just a number', (t) async {
    final api = apiReturning(200, summaryJson);
    await pump(t, StatementCard(api: api, documentId: 'doc_stmt'));

    expect(find.textContaining('2 gaps'), findsOneWidget);
    expect(find.textContaining('no invoice on file'), findsOneWidget);
  });

  testWidgets('lines are hidden until "Show N lines" is tapped', (t) async {
    final api = apiReturning(200, summaryJson);
    await pump(t, StatementCard(api: api, documentId: 'doc_stmt'));

    expect(find.text('Show 12 lines'), findsOneWidget);
    expect(find.text('SWIGGY BLR 080'), findsNothing);

    await t.tap(find.text('Show 12 lines'));
    await t.pumpAndSettle();

    expect(find.text('Hide lines'), findsOneWidget);
    // Line 1 has a resolved counterparty name, shown in preference to the
    // raw descriptor.
    expect(find.text('Swiggy Limited'), findsOneWidget);
    // Line 2 has no resolved counterparty, so the raw descriptor is the
    // fallback — never a blank row.
    expect(find.text('UNKNOWN MERCHANT'), findsOneWidget);
  });

  testWidgets('a document that is not a statement renders nothing, not an error', (t) async {
    final api = apiReturning(400, {
      'error': 'not_a_statement',
      'message': 'a.pdf is a merchant_invoice, not a statement.',
    });
    await pump(t, StatementCard(api: api, documentId: 'doc_invoice'));

    // No card, no error text — the common case (most documents are not
    // statements) must not look like a failure.
    expect(find.byType(Container), findsNothing);
    expect(find.textContaining('Could not load'), findsNothing);
    expect(find.textContaining('Statement import'), findsNothing);
  });

  testWidgets('a genuine transport failure DOES show an error, distinct from "not a statement"', (t) async {
    final api = VaultApi(
      baseUrl: 'http://x',
      token: 't',
      client: MockClient((req) async => http.Response('', 500)),
    );
    await pump(t, StatementCard(api: api, documentId: 'doc_stmt'));

    expect(find.textContaining('Could not load statement'), findsOneWidget);
  });
}
