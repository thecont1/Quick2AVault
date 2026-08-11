import '../api.dart';
import 'intake/state.dart' as feature_intake;
import 'people/state.dart' as feature_people;
import 'review/state.dart' as feature_review;
import 'settings/state.dart' as feature_settings;

extension VaultApiDesktopFeatures on VaultApi {
  Future<List<feature_intake.IntakeItem>> featureIntakeStatus({
    int limit = 200,
  }) async {
    final rows = await intakeStatus(limit: limit);
    return rows.map((row) {
      final kind = switch (row.kind) {
        'duplicate' => feature_intake.PipelineState.duplicate,
        'irrelevant' => feature_intake.PipelineState.irrelevant,
        'failed' => feature_intake.PipelineState.failed,
        'password_needed' => feature_intake.PipelineState.passwordNeeded,
        _ => _pipeline(row.processingState),
      };
      return feature_intake.IntakeItem(
        id: row.documentId ?? 'intake-${row.id}',
        intakeId: row.id,
        filename: row.filename,
        entity: 'Unidentified',
        entityKind: feature_people.EntityKind.person,
        state: kind,
        source: row.canonicalPath ?? row.source,
        date: row.createdAt,
        reason: row.reason ?? row.lastError,
        sourcePath: row.canonicalPath,
        documentId: row.documentId,
      );
    }).toList();
  }

  Future<List<feature_people.EntitySummary>> featureEntities({
    feature_people.EntityKind? kind,
  }) async {
    final rows = await entities(kind: kind?.name);
    return rows.map(feature_people.EntitySummary.fromJson).toList();
  }

  Future<
    ({
      feature_settings.AppSettings settings,
      feature_settings.JurisdictionPack jurisdiction,
    })
  >
  featureSettingsBundle() async {
    final raw = await settings();
    return (
      settings: feature_settings.AppSettings.fromJson(raw),
      jurisdiction: feature_settings.JurisdictionPack.fromJson(
        ((raw['jurisdiction'] ?? const {}) as Map).cast<String, dynamic>(),
      ),
    );
  }

  Future<feature_settings.AppSettings> featureSettings() async =>
      (await featureSettingsBundle()).settings;

  Future<feature_settings.JurisdictionPack> featureJurisdiction() async =>
      (await featureSettingsBundle()).jurisdiction;

  Future<void> saveFeatureSettings(
    feature_settings.AppSettings before,
    feature_settings.AppSettings after,
  ) async {
    if (before.learningEnabled != after.learningEnabled) {
      await toggleLearning(after.learningEnabled);
    }
    await saveDesktopPreferences(after.toApiJson(before: before));
  }

  Future<feature_review.DetailDocument> featureDocumentDetail(
    VaultDoc summary,
  ) async {
    final results = await Future.wait<Object>([
      documentDetail(summary.id),
      audit(summary.id),
    ]);
    final detail = results[0] as DocumentDetail;
    final history = results[1] as List<AuditEntry>;
    final amountMinor = int.tryParse(detail['amount_minor']?.value ?? '');
    final currency = detail['currency']?.value ?? '';
    final amount = amountMinor == null
        ? 'Amount not set'
        : money(amountMinor, currency.isEmpty ? null : currency);
    final rawType = detail['document_type']?.value ?? summary.docType;
    final fields = <feature_review.DetailField>[];
    for (final entry in detail.effective.entries) {
      fields.add(
        feature_review.DetailField(
          id: entry.key,
          label: _fieldLabel(entry.key),
          value: entry.value.value,
          provenance: feature_review.ClaimProvenance.fromApi(
            entry.value.source,
          ),
          confidence: (detail.claims[entry.key]?['confidence'] as num?)
              ?.toDouble(),
          editable: detail.editableFields.contains(entry.key),
        ),
      );
    }
    for (final entry in detail.referenceIds.entries) {
      fields.add(
        feature_review.DetailField(
          id: 'reference_${entry.key}',
          label: _fieldLabel(entry.key),
          value: entry.value.toString(),
          editable: false,
        ),
      );
    }
    if (detail.subtotalMinor case final subtotal?) {
      fields.add(
        feature_review.DetailField(
          id: 'subtotal_minor',
          label: 'Subtotal',
          value: money(subtotal, currency.isEmpty ? null : currency),
          editable: false,
        ),
      );
    }
    if (detail.taxMinor case final tax?) {
      fields.add(
        feature_review.DetailField(
          id: 'tax_minor',
          label: 'Tax',
          value: money(tax, currency.isEmpty ? null : currency),
          editable: false,
        ),
      );
    }
    for (final transaction in detail.transactions) {
      fields.add(
        feature_review.DetailField(
          id: 'transaction_${transaction.id}',
          label: 'Linked transaction (${transaction.direction})',
          value:
              '${transaction.sourceAmount} · linked by ${transaction.linkedBy ?? 'unknown'}',
          provenance: feature_review.ClaimProvenance.fromApi(
            transaction.linkedBy,
          ),
          editable: false,
        ),
      );
    }
    return feature_review.DetailDocument(
      id: summary.id,
      filename: summary.filename,
      amount: amount,
      type: feature_review.DetailType.fromApi(rawType),
      bucket: feature_review.ImpactBucket.fromApi(
        detail['impact_bucket']?.value,
      ),
      confirmed:
          detail.effective.isNotEmpty &&
          detail.effective.values.every((value) => value.status == 'confirmed'),
      confidence: (detail.extraction?['confidence'] as num?)?.toDouble(),
      advisoryHint: detail.extraction?['advisory_hint']?.toString(),
      lines: detail.lineItems.map(_detailLine).toList(),
      fields: fields,
      parties: detail.parties.map(_detailParty).toList(),
      currencyConversion: _currencyConversion(detail),
      auditCount: history.length,
      auditEntries: history
          .map(
            (entry) =>
                '${entry.field}: ${entry.oldValue ?? 'unset'} → ${entry.newValue ?? 'unset'}',
          )
          .toList(),
      identityReasoning: detail.extraction?['identity_reasoning']?.toString(),
    );
  }
}

feature_intake.PipelineState _pipeline(String value) => switch (value) {
  'stable' => feature_intake.PipelineState.stable,
  'hashed' => feature_intake.PipelineState.hashed,
  'triaged' => feature_intake.PipelineState.triaged,
  'converting' || 'convert' => feature_intake.PipelineState.converting,
  'analysing' || 'analysis' => feature_intake.PipelineState.analysing,
  'complete' || 'archived' => feature_intake.PipelineState.complete,
  'failed' => feature_intake.PipelineState.failed,
  'duplicate' => feature_intake.PipelineState.duplicate,
  'irrelevant' => feature_intake.PipelineState.irrelevant,
  'password_needed' => feature_intake.PipelineState.passwordNeeded,
  _ => feature_intake.PipelineState.received,
};

feature_review.DetailLine _detailLine(Map<String, dynamic> line) =>
    feature_review.DetailLine(
      (line['description'] ?? line['security_name'] ?? 'Line item').toString(),
      (line['hsn_sac'] ?? line['isin'] ?? '').toString(),
      (line['quantity'] ?? '').toString(),
      (line['rate'] ?? line['price'] ?? '').toString(),
      (line['amount'] ?? line['amount_minor'] ?? '').toString(),
      direction: line['direction']?.toString(),
    );

feature_review.DetailParty _detailParty(Map<String, dynamic> party) =>
    feature_review.DetailParty(
      role: feature_review.DocumentPartyRole.fromApi(party['role']?.toString()),
      entityId: party['entity_id']?.toString(),
      displayName: party['display_name']?.toString(),
      kind: party['kind']?.toString(),
      provenance: feature_review.ClaimProvenance.fromApi(
        party['source']?.toString(),
      ),
      confidence: (party['confidence'] as num?)?.toDouble(),
    );

feature_review.CurrencyConversionDetail? _currencyConversion(
  DocumentDetail detail,
) {
  final conversion = detail.extraction?['currency_conversion'];
  if (conversion is! Map) return null;
  final value = conversion.cast<String, dynamic>();
  return feature_review.CurrencyConversionDetail(
    originalAmount: (value['original_amount'] ?? '').toString(),
    originalCurrency: (value['original_currency'] ?? '').toString(),
    convertedAmount: value['converted_amount']?.toString(),
    homeCurrency: (value['home_currency'] ?? 'INR').toString(),
    rate: value['rate']?.toString(),
    rateDate: value['rate_date']?.toString(),
    rateSource: value['rate_source']?.toString(),
    stale: value['fresh'] == false,
    provenance: feature_review.ClaimProvenance.fromApi(
      value['provenance']?.toString(),
    ),
  );
}

String _fieldLabel(String value) => value
    .split('_')
    .map(
      (word) =>
          word.isEmpty ? word : '${word[0].toUpperCase()}${word.substring(1)}',
    )
    .join(' ');
