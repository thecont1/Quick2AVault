// WO12 phase 2 UI tests: status badges, evidence unlink, and
// reconciliation-ambiguity Learning buttons.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/txn_card.dart';
import 'package:quick2avault_desktop/widgets/evidence_panel.dart';
import 'package:quick2avault_desktop/features/learning/view.dart';
import 'package:quick2avault_desktop/features/learning/state.dart';

// ── Helpers ────────────────────────────────────────────────────────────────

Txn _txn({
  String id = 't1',
  String direction = 'out',
  int amountMinor = 472287,
  String? currency = 'INR',
  String status = 'evidenced',
  String? reversesTransactionId,
  List<Evidence> evidence = const [],
}) =>
    Txn(
      id: id,
      direction: direction,
      amountMinor: amountMinor,
      currency: currency,
      occurredAt: '2026-08-09',
      fyKey: '2026-27',
      status: status,
      reversesTransactionId: reversesTransactionId,
      evidence: evidence,
    );

EvidenceCard _card(Txn t, {List<Evidence> evidence = const []}) => EvidenceCard(
      transaction: t,
      legs: const [],
      evidence: evidence,
      provenance: const [],
      summary: 'one document, one rupee',
    );

Evidence _ev(String id, String filename, {String role = 'merchant_invoice'}) =>
    Evidence(id: id, filename: filename, role: role);

/// A fake API that records unlink calls and returns success.
class _FakeApi extends VaultApi {
  final List<(String, String)> unlinkCalls = [];
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1', token: 'test');

  @override
  Future<bool> unlinkEvidence(String transactionId, String documentId) async {
    unlinkCalls.add((transactionId, documentId));
    return true;
  }
}

// ── Status badge tests ─────────────────────────────────────────────────────

void main() {
  testWidgets('TxnCard shows AWAITING SETTLEMENT badge', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TxnCard(
          txn: _txn(status: 'awaiting_settlement'),
          selected: false,
          onTap: () {},
        ),
      ),
    ));
    expect(find.text('AWAITING SETTLEMENT'), findsOneWidget);
  });

  testWidgets('TxnCard shows NO INVOICE badge', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TxnCard(
          txn: _txn(status: 'no_invoice'),
          selected: false,
          onTap: () {},
        ),
      ),
    ));
    expect(find.text('NO INVOICE'), findsOneWidget);
  });

  testWidgets('TxnCard shows REVERSAL badge for refund transactions',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TxnCard(
          txn: _txn(
            direction: 'in',
            reversesTransactionId: 't_original',
          ),
          selected: false,
          onTap: () {},
        ),
      ),
    ));
    expect(find.text('REVERSAL'), findsOneWidget);
  });

  testWidgets('TxnCard does not show status badges for evidenced transactions',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TxnCard(
          txn: _txn(status: 'evidenced'),
          selected: false,
          onTap: () {},
        ),
      ),
    ));
    expect(find.text('AWAITING SETTLEMENT'), findsNothing);
    expect(find.text('NO INVOICE'), findsNothing);
    expect(find.text('REVERSAL'), findsNothing);
  });

  // ── Evidence unlink tests ────────────────────────────────────────────────

  testWidgets('EvidencePanel shows unlink button when API is provided',
      (tester) async {
    final api = _FakeApi();
    final txn = _txn(evidence: [_ev('d1', 'invoice.pdf')]);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: EvidencePanel(
            card: _card(txn, evidence: [_ev('d1', 'invoice.pdf')]),
            api: api,
            onEdited: () {},
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    // The unlink icon button should be present
    expect(find.byTooltip('Unlink evidence'), findsOneWidget);
  });

  testWidgets('EvidencePanel does not show unlink button without API',
      (tester) async {
    final txn = _txn(evidence: [_ev('d1', 'invoice.pdf')]);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: EvidencePanel(
            card: _card(txn, evidence: [_ev('d1', 'invoice.pdf')]),
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Unlink evidence'), findsNothing);
  });

  testWidgets('EvidencePanel shows REVERSAL badge for refund_note evidence',
      (tester) async {
    final txn = _txn(evidence: [_ev('d1', 'refund.pdf', role: 'refund_note')]);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: EvidencePanel(
            card: _card(txn, evidence: [_ev('d1', 'refund.pdf', role: 'refund_note')]),
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('REVERSAL'), findsOneWidget);
  });

  testWidgets('EvidencePanel unlink calls API and triggers refresh',
      (tester) async {
    final api = _FakeApi();
    var refreshed = false;
    final txn = _txn(evidence: [_ev('d1', 'invoice.pdf')]);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: EvidencePanel(
            card: _card(txn, evidence: [_ev('d1', 'invoice.pdf')]),
            api: api,
            onEdited: () => refreshed = true,
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();

    // Tap the unlink button
    await tester.tap(find.byTooltip('Unlink evidence'));
    await tester.pumpAndSettle();

    // Confirm in the dialog
    await tester.tap(find.text('Unlink'));
    await tester.pumpAndSettle();

    // The API should have been called and the refresh callback fired
    expect(api.unlinkCalls.length, 1);
    expect(api.unlinkCalls.first.$1, 't1');
    expect(api.unlinkCalls.first.$2, 'd1');
    expect(refreshed, true);
  });

  // ── Learning reconciliation button tests ────────────────────────────────

  testWidgets('LearningPanel shows Link/Don\'t link/Later for reconciliation questions',
      (tester) async {
    final questions = [
      LearningPrompt(
        id: '1',
        prompt: 'These look like the same purchase. Link?',
        why: 'amount exact, date within 1d',
        trigger: 'reconciliation-ambiguity',
        novelty: 0.75,
      ),
    ];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: LearningPanel(
          enabled: true,
          questions: questions,
          onAction: (_) {},
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Link'), findsOneWidget);
    expect(find.text("Don't link"), findsOneWidget);
    expect(find.text('Later'), findsOneWidget);
    // Should NOT show the generic buttons
    expect(find.text('Confirm'), findsNothing);
    expect(find.text('Choose from list'), findsNothing);
    expect(find.text('Create new'), findsNothing);
  });

  testWidgets('LearningPanel shows generic buttons for non-reconciliation questions',
      (tester) async {
    final questions = [
      LearningPrompt(
        id: '2',
        prompt: 'Is this a new vendor?',
        why: 'unseen descriptor',
        trigger: 'unseen_entity',
        novelty: 0.8,
      ),
    ];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: LearningPanel(
          enabled: true,
          questions: questions,
          onAction: (_) {},
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Confirm'), findsOneWidget);
    expect(find.text('Choose from list'), findsOneWidget);
    expect(find.text('Create new'), findsOneWidget);
    expect(find.text('Later'), findsOneWidget);
    // Should NOT show reconciliation buttons
    expect(find.text('Link'), findsNothing);
    expect(find.text("Don't link"), findsNothing);
  });

  testWidgets('LearningPanel Link button emits link: action', (tester) async {
    String? captured;
    final questions = [
      LearningPrompt(
        id: '5',
        prompt: 'These look like the same purchase. Link?',
        why: 'amount exact',
        trigger: 'reconciliation-ambiguity',
        novelty: 0.75,
      ),
    ];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: LearningPanel(
          enabled: true,
          questions: questions,
          onAction: (a) => captured = a,
        ),
      ),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Link'));
    await tester.pumpAndSettle();
    expect(captured, 'link:5');
  });

  testWidgets('LearningPanel Don\'t link button emits dismiss: action',
      (tester) async {
    String? captured;
    final questions = [
      LearningPrompt(
        id: '6',
        prompt: 'These look like the same purchase. Link?',
        why: 'amount exact',
        trigger: 'reconciliation-ambiguity',
        novelty: 0.75,
      ),
    ];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: LearningPanel(
          enabled: true,
          questions: questions,
          onAction: (a) => captured = a,
        ),
      ),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.text("Don't link"));
    await tester.pumpAndSettle();
    expect(captured, 'dismiss:6');
  });
}
