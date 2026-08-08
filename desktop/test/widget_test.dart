// Unit tests that don't require a live daemon.
//
// NOTE: a widget test that pumps Quick2AVaultApp will attempt a real HTTP call
// in initState; TestWidgetsFlutterBinding stubs those to 400 and the boot
// probe fails the test. The daemon-facing path is verified end-to-end by
// running the real app against the real daemon, not here.
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';

void main() {
  test('rupees() uses Indian lakh/crore grouping, not thousands', () {
    // The jurisdiction-pack rule that trips every naive formatter.
    expect(rupees(0), '₹0.00');
    expect(rupees(64372), '₹643.72');
    expect(rupees(96009), '₹960.09');
    expect(rupees(100000), '₹1,000.00');
    expect(rupees(14235628), '₹1,42,356.28'); // one lakh forty-two thousand
    expect(rupees(100000000), '₹10,00,000.00'); // ten lakh
    expect(rupees(1000000000), '₹1,00,00,000.00'); // one crore
    expect(rupees(-64372), '-₹643.72');
  });

  test('Txn.multiEvidence flags the many-documents-one-rupee case', () {
    const single = Txn(
      id: 't1', direction: 'out', amountMinor: 64372,
      occurredAt: '2026-08-06', fyKey: 'FY 2026-27',
      evidence: [Evidence(id: 'd1', filename: 'a.pdf', role: 'merchant_invoice')],
    );
    const linked = Txn(
      id: 't2', direction: 'out', amountMinor: 64372,
      occurredAt: '2026-08-06', fyKey: 'FY 2026-27',
      evidence: [
        Evidence(id: 'd1', filename: 'a.pdf', role: 'merchant_invoice'),
        Evidence(id: 'd2', filename: 'b.eml', role: 'card_confirmation'),
      ],
    );
    expect(single.multiEvidence, isFalse);
    expect(linked.multiEvidence, isTrue);
  });

  test('transfers are flagged and carry no counterparty', () {
    const t = Txn(
      id: 't3', direction: 'transfer', amountMinor: 100000,
      occurredAt: '2026-08-07', fyKey: 'FY 2026-27', counterparty: null,
    );
    expect(t.isTransfer, isTrue);
    expect(t.counterparty, isNull);
  });

  test('sharedRefValues finds the join key across documents', () {
    final card = EvidenceCard(
      transaction: const Txn(
        id: 't', direction: 'out', amountMinor: 64372,
        occurredAt: '2026-08-06', fyKey: 'FY 2026-27',
      ),
      legs: const [],
      evidence: const [
        Evidence(id: 'd1', filename: 'a.pdf', role: 'merchant_invoice', extraction: {
          'reference_ids': {'invoice_no': 'SW/4471829', 'approval_code': '042917'}
        }),
        Evidence(id: 'd2', filename: 'b.eml', role: 'card_confirmation', extraction: {
          'reference_ids': {'approval_code': '042917'}
        }),
      ],
      provenance: const [],
      summary: '2 documents describe this one payment.',
    );
    // Only the approval code appears on both — that's what collapsed them.
    expect(card.sharedRefValues, {'042917'});
  });
}
