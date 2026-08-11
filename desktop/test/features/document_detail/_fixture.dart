import 'dart:convert';
import 'dart:io';

import 'package:quick2avault_desktop/features/review/document_detail.dart';

class PanelFixture {
  final Map<String, dynamic> json;
  const PanelFixture(this.json);

  String text(String key) => json[key] as String;
  List<Map<String, dynamic>> list(String key) =>
      (json[key] as List).cast<Map<String, dynamic>>();

  DetailDocument toDocument() => DetailDocument(
    id: text('id'),
    filename: text('filename'),
    amount: text('amount'),
    type: DetailType.fromApi(text('type')),
    bucket: ImpactBucket.fromApi(text('bucket')),
    confirmed: true,
    confidence: .97,
    advisoryHint: text('advisory_hint'),
    identityReasoning: text('identity_reasoning'),
    auditEntries: (json['audit_entries'] as List).cast<String>(),
    auditCount: (json['audit_entries'] as List).length,
    fields: _fields(),
    parties: _parties(),
    lines: _lines(),
    currencyConversion: json['currency_conversion'] == null
        ? null
        : CurrencyConversionDetail(
            originalAmount: text('currency_conversion').split(' ').first,
            originalCurrency: 'USD',
            convertedAmount: text('amount'),
          ),
  );

  List<DetailField> _fields() {
    final values = <String, String>{
      if (json['person'] != null) 'Person': text('person'),
      if (json['document_type'] != null) 'Document type': text('document_type'),
      if (json['vendor'] != null) 'Vendor': text('vendor'),
      if (json['document_date'] != null) 'Document date': text('document_date'),
      if (json['financial_year'] != null)
        'Financial year': text('financial_year'),
      if (json['currency_conversion'] != null)
        'Currency conversion': text('currency_conversion'),
      if (json['broker'] != null) 'Broker': text('broker'),
      if (json['client'] != null) 'Client': text('client'),
      if (json['trade_date'] != null) 'Trade date': text('trade_date'),
      if (json['contract_note_no'] != null)
        'Contract Note No.': text('contract_note_no'),
    };
    return [
      for (final entry in values.entries)
        DetailField(
          id: entry.key.toLowerCase().replaceAll(' ', '_'),
          label: entry.key,
          value: entry.value,
          editable: false,
          provenance: ClaimProvenance.userConfirmed,
        ),
    ];
  }

  List<DetailParty> _parties() => [
    if (json['person'] != null)
      DetailParty(
        role: DocumentPartyRole.issuer,
        entityId: 'person-priya',
        displayName: text('person'),
        kind: 'person',
      ),
    if (json['client'] != null)
      DetailParty(
        role: DocumentPartyRole.owner,
        entityId: 'person-priya',
        displayName: text('client'),
        kind: 'person',
      ),
    if (json['vendor'] != null)
      DetailParty(
        role: DocumentPartyRole.counterparty,
        entityId: 'org-petasight',
        displayName: text('vendor'),
        kind: 'organisation',
      ),
    if (json['broker'] != null)
      DetailParty(
        role: DocumentPartyRole.counterparty,
        entityId: 'org-paytm',
        displayName: text('broker'),
        kind: 'organisation',
      ),
  ];

  List<DetailLine> _lines() {
    final rows = json['lines'] ?? json['trades'];
    return [
      for (final row in (rows as List).cast<Map<String, dynamic>>())
        DetailLine(
          row['description'] as String,
          (row['code'] ?? row['isin']) as String,
          row['quantity'] as String,
          row['rate'] as String,
          row['amount'] as String,
          direction: row['direction'] as String?,
        ),
    ];
  }
}

PanelFixture loadFixture(String name) => PanelFixture(
  jsonDecode(
        File(
          'test/features/document_detail/_fixtures/$name.json',
        ).readAsStringSync(),
      )
      as Map<String, dynamic>,
);
