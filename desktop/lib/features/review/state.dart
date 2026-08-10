enum DetailType {
  taxInvoice('tax_invoice'),
  contractNote('contract_note'),
  bankStatement('bank_statement'),
  cardConfirmation('card_confirmation'),
  rentReceipt('rent_receipt'),
  form16('form_16'),
  unknown('unknown');

  const DetailType(this.apiValue);
  final String apiValue;

  factory DetailType.fromApi(String? value) => DetailType.values.firstWhere(
    (type) => type.apiValue == value,
    orElse: () => DetailType.unknown,
  );
}

enum ClaimProvenance {
  aiDerived('AI inferred'),
  userConfirmed('Edited by you'),
  ruleDerived('Rule derived');

  const ClaimProvenance(this.label);
  final String label;

  factory ClaimProvenance.fromApi(String? value) => switch (value) {
    'user' || 'user-confirmed' => ClaimProvenance.userConfirmed,
    'rule' || 'rule-derived' => ClaimProvenance.ruleDerived,
    _ => ClaimProvenance.aiDerived,
  };
}

enum DocumentPartyRole {
  owner('Owner'),
  counterparty('Counterparty'),
  issuer('Issuer'),
  sourceOfFunds('Source of funds');

  const DocumentPartyRole(this.label);
  final String label;

  String get apiValue => switch (this) {
    DocumentPartyRole.sourceOfFunds => 'source_of_funds',
    _ => name,
  };

  factory DocumentPartyRole.fromApi(String? value) => switch (value) {
    'owner' => DocumentPartyRole.owner,
    'issuer' => DocumentPartyRole.issuer,
    'source_of_funds' => DocumentPartyRole.sourceOfFunds,
    _ => DocumentPartyRole.counterparty,
  };
}

enum ImpactBucket {
  income('Income'),
  expense('Expense'),
  investmentPurchase('Investment purchase'),
  investmentSale('Investment sale'),
  transfer('Transfer'),
  fee('Fee'),
  refund('Refund'),
  uncategorized('Uncategorized');

  const ImpactBucket(this.label);
  final String label;

  String get apiValue => switch (this) {
    ImpactBucket.investmentPurchase => 'investment_purchase',
    ImpactBucket.investmentSale => 'investment_sale',
    _ => name,
  };

  factory ImpactBucket.fromApi(String? value) => ImpactBucket.values.firstWhere(
    (bucket) => bucket.apiValue == value,
    orElse: () => ImpactBucket.uncategorized,
  );
}

class DetailLine {
  final String description;
  final String code;
  final String quantity;
  final String rate;
  final String amount;
  final String? direction;

  const DetailLine(
    this.description,
    this.code,
    this.quantity,
    this.rate,
    this.amount, {
    this.direction,
  });
}

class DetailField {
  final String id;
  final String label;
  final String value;
  final ClaimProvenance provenance;
  final double? confidence;
  final bool editable;
  final List<String> choices;
  final String? why;

  const DetailField({
    required this.id,
    required this.label,
    required this.value,
    this.provenance = ClaimProvenance.aiDerived,
    this.confidence,
    this.editable = true,
    this.choices = const [],
    this.why,
  });
}

class DetailParty {
  final DocumentPartyRole role;
  final String? entityId;
  final String? displayName;
  final String? kind;
  final ClaimProvenance provenance;
  final double? confidence;

  const DetailParty({
    required this.role,
    this.entityId,
    this.displayName,
    this.kind,
    this.provenance = ClaimProvenance.aiDerived,
    this.confidence,
  });
}

class CurrencyConversionDetail {
  final String originalAmount;
  final String originalCurrency;
  final String? convertedAmount;
  final String homeCurrency;
  final String? rate;
  final String? rateDate;
  final String? rateSource;
  final bool stale;
  final ClaimProvenance provenance;

  const CurrencyConversionDetail({
    required this.originalAmount,
    required this.originalCurrency,
    this.convertedAmount,
    this.homeCurrency = 'INR',
    this.rate,
    this.rateDate,
    this.rateSource,
    this.stale = false,
    this.provenance = ClaimProvenance.ruleDerived,
  });
}

class DetailDocument {
  final String id;
  final String filename;
  final String amount;
  final DetailType type;
  final ImpactBucket bucket;
  final bool confirmed;
  final double? confidence;
  final String? advisoryHint;
  final String? markdown;
  final List<DetailLine> lines;
  final List<DetailField> fields;
  final List<DetailParty> parties;
  final CurrencyConversionDetail? currencyConversion;
  final int auditCount;
  final List<String> auditEntries;
  final String? identityReasoning;

  const DetailDocument({
    this.id = '',
    required this.filename,
    required this.amount,
    required this.type,
    this.bucket = ImpactBucket.uncategorized,
    this.confirmed = false,
    this.confidence,
    this.advisoryHint,
    this.markdown,
    this.lines = const [],
    this.fields = const [],
    this.parties = const [],
    this.currencyConversion,
    this.auditCount = 0,
    this.auditEntries = const [],
    this.identityReasoning,
  });

  factory DetailDocument.invoice({
    String id = '',
    required String filename,
    required String amount,
    List<DetailLine> lines = const [],
    List<DetailField> fields = const [],
    List<DetailParty> parties = const [],
    CurrencyConversionDetail? currencyConversion,
    String? markdown,
  }) => DetailDocument(
    id: id,
    filename: filename,
    amount: amount,
    type: DetailType.taxInvoice,
    bucket: ImpactBucket.income,
    confirmed: true,
    confidence: .9,
    lines: lines,
    fields: fields,
    parties: parties,
    currencyConversion: currencyConversion,
    markdown: markdown,
    auditCount: 3,
  );

  factory DetailDocument.contractNote({
    String id = '',
    required String filename,
    required String amount,
    List<DetailLine> lines = const [],
    List<DetailField> fields = const [],
    List<DetailParty> parties = const [],
    String? markdown,
  }) => DetailDocument(
    id: id,
    filename: filename,
    amount: amount,
    type: DetailType.contractNote,
    bucket: ImpactBucket.investmentPurchase,
    confirmed: true,
    confidence: .9,
    lines: lines,
    fields: fields,
    parties: parties,
    markdown: markdown,
    auditCount: 7,
  );

  String get impactWording => switch (bucket) {
    ImpactBucket.income => 'Income of $amount.',
    ImpactBucket.expense => 'Expense of $amount.',
    ImpactBucket.investmentPurchase => 'Added $amount to investments.',
    ImpactBucket.investmentSale => 'Removed $amount from investments.',
    ImpactBucket.transfer => 'Transferred $amount.',
    ImpactBucket.fee => 'Fee of $amount.',
    ImpactBucket.refund => 'Refund of $amount.',
    ImpactBucket.uncategorized => '$amount needs an impact bucket.',
  };
}

typedef DetailFieldChanged =
    Future<void> Function(String documentId, String field, Object? value);

typedef DetailPartyChanged =
    Future<void> Function(
      String documentId,
      DocumentPartyRole role,
      String? entityId,
    );

enum DocumentManageAction {
  openOriginal,
  openMarkdown,
  reprocess,
  removeFromActive,
  deletePermanently,
}

typedef DocumentActionCallback =
    Future<void> Function(String documentId, DocumentManageAction action);
