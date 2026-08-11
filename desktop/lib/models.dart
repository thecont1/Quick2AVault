/// Immutable, generated API models for the Quick2AVault daemon contract.
///
/// QAV-FLT-04: replaces the hand-written fromJson classes that lived in
/// api.dart with Freezed + json_serializable generated models.  Every model
/// is immutable, has generated == / hashCode / copyWith / toString, and
/// generated JSON serialization.
///
/// Exceptions ([VaultAuthException], [PersonConflict], …) and non-JSON
/// types ([VaultError], [VaultEvent]) remain hand-written because they are
/// not deserialized from daemon responses.
///
/// This file is re-exported by api.dart so existing `import 'api.dart'`
/// call sites continue to resolve every model name.
library;

import 'package:freezed_annotation/freezed_annotation.dart';

import 'core/utils/money.dart';

part 'models.freezed.dart';
part 'models.g.dart';

// ─── JSON converter helpers ─────────────────────────────────────────────
//
// json_serializable has no built-in mapping for int→bool, Dart record types,
// Set<String>, or Map<String,String>.  These top-level functions are wired
// to @JsonKey(fromJson:/toJson:) on the fields that need them.

/// Daemon encodes booleans as 0/1 integers for some legacy fields.
bool _intToBool(dynamic v) => v == 1;

/// Accepts either 0/1 or true/false (intake triage_review is inconsistent).
bool _flexibleBool(dynamic v) => v == 1 || v == true;

/// Parses a daemon timestamp, falling back to now() on parse failure
/// (matches the original IntakeEvent.fromJson behaviour).
DateTime _dateTimeOrNow(dynamic v) {
  if (v == null) return DateTime.now();
  return DateTime.tryParse(v.toString()) ?? DateTime.now();
}

/// Nullable timestamp — null when the daemon omits the field.
DateTime? _nullableDateTime(dynamic v) {
  if (v == null) return null;
  return DateTime.tryParse(v.toString());
}

/// Currency code: null when empty or absent (work order 05 §A.2 — null is a
/// review state, not a silent INR default).
String? _currencyFromJson(dynamic v) {
  if (v == null) return null;
  final s = v.toString();
  return s.isNotEmpty ? s : null;
}

/// `List<String>` → `Set<String>` for editable-fields sets.
Set<String> _stringSetFromJson(dynamic v) =>
    ((v ?? const []) as List).cast<String>().toSet();
List<String> _stringSetToJson(Set<String> v) => v.toList();

/// `Map<String, dynamic>` → `Map<String, String>` (values stringified).
Map<String, String> _stringMapFromJson(dynamic v) {
  if (v == null) return {};
  return (v as Map).map((k, val) => MapEntry(k.toString(), val.toString()));
}

Map<String, dynamic> _stringMapToJson(Map<String, String> v) =>
    v.map((k, val) => MapEntry(k, val));

// ─── Record-type typedefs ───────────────────────────────────────────────
//
// Dart record types cannot be written directly in function parameter
// positions without a typedef — the parser reads `({String a}) v` as a
// named-parameter list.  These typedefs give the record types a name.

/// A quick-pick period item: key + label.
typedef QuickItem = ({String key, String label});

/// Original-currency amount on a statement line.
typedef FxOriginal = ({int amountMinor, String currency});

// ─── Record-type converters ─────────────────────────────────────────────

/// Periods.quick items: {key, label} → QuickItem
QuickItem _quickItemFromJson(dynamic v) {
  final m = v as Map<String, dynamic>;
  return (
    key: (m['key'] ?? '') as String,
    label: (m['label'] ?? '') as String,
  );
}

Map<String, dynamic> _quickItemToJson(QuickItem v) =>
    {'key': v.key, 'label': v.label};

List<QuickItem> _quickListFromJson(dynamic v) =>
    ((v ?? const []) as List).map(_quickItemFromJson).toList();

List<Map<String, dynamic>> _quickListToJson(List<QuickItem> v) =>
    v.map(_quickItemToJson).toList();

/// StatementLine.fxOriginal: {amount_minor, currency} → FxOriginal?
FxOriginal? _fxOriginalFromJson(dynamic v) {
  if (v == null) return null;
  final m = v as Map<String, dynamic>;
  return (
    amountMinor: (m['amount_minor'] as num).toInt(),
    currency: m['currency'] as String,
  );
}

Map<String, dynamic>? _fxOriginalToJson(FxOriginal? v) =>
    v == null ? null : {'amount_minor': v.amountMinor, 'currency': v.currency};

// ════════════════════════════════════════════════════════════════════════
// Treemap models
// ════════════════════════════════════════════════════════════════════════

/// One tile of the spending treemap: a category, its total, and the raw
/// impact_buckets that were folded into it (kept so the fold is auditable
/// in a tooltip rather than being an invisible transformation).
@freezed
abstract class TreemapSource with _$TreemapSource {
  const factory TreemapSource({
    @Default('') String bucket,
    @Default(0) int amountMinor,
    @Default(0) int transactions,
  }) = _TreemapSource;

  factory TreemapSource.fromJson(Map<String, dynamic> json) =>
      _$TreemapSourceFromJson(json);
}

@freezed
abstract class TreemapNode with _$TreemapNode {
  const factory TreemapNode({
    @Default('') String id,
    @Default('') String label,
    @Default(0) int amountMinor,
    @Default(0) int transactions,
    @Default(false) bool known,
    @Default([]) List<TreemapSource> sources,
  }) = _TreemapNode;

  factory TreemapNode.fromJson(Map<String, dynamic> json) =>
      _$TreemapNodeFromJson(json);
}

@freezed
abstract class TreemapData with _$TreemapData {
  const TreemapData._();

  const factory TreemapData({
    @Default([]) List<TreemapNode> nodes,
    @Default(0) int totalMinor,
    @Default(0) int rawBuckets,
  }) = _TreemapData;

  static const empty = TreemapData();

  factory TreemapData.fromJson(Map<String, dynamic> json) =>
      _$TreemapDataFromJson(json);
}

// ════════════════════════════════════════════════════════════════════════
// Period models
// ════════════════════════════════════════════════════════════════════════

/// The period a snapshot covers, as resolved by the daemon.
@Freezed(fromJson: false)
abstract class Period with _$Period {
  const Period._();

  const factory Period({
    @Default('all') String key,
    @Default('') String label,
    String? from,
    String? to,
  }) = _Period;

  /// Accepts a nullable map — the daemon omits `period` when no data matches.
  factory Period.fromJson(Map<String, dynamic>? j) => Period(
        key: (j?['key'] ?? 'all') as String,
        label: (j?['label'] ?? '') as String,
        from: j?['from'] as String?,
        to: j?['to'] as String?,
      );
}

/// What the period selector should offer — months and financial years are
/// derived from the data, so an empty month is never shown.
@freezed
abstract class Periods with _$Periods {
  const Periods._();

  const factory Periods({
    @Default('') String currentFy,
    @Default('') String currentMonth,
    @JsonKey(fromJson: _quickListFromJson, toJson: _quickListToJson)
    @Default([])
    List<QuickItem> quick,
    @Default([]) List<String> months,
    @Default([]) List<String> financialYears,
  }) = _Periods;

  static const empty = Periods();

  factory Periods.fromJson(Map<String, dynamic> json) =>
      _$PeriodsFromJson(json);
}

// ════════════════════════════════════════════════════════════════════════
// Person models
// ════════════════════════════════════════════════════════════════════════

/// A human the vault knows about. `isMember` marks people who share this
/// vault (self, spouse); everyone else is a counterparty-adjacent person such
/// as a landlord or tenant.
@freezed
abstract class Person with _$Person {
  const Person._();

  const factory Person({
    @Default('') String id,
    @Default('') String displayName,
    @JsonKey(name: 'subtype') String? relationship,
    @JsonKey(fromJson: _intToBool) @Default(false) bool isMember,
    @JsonKey(fromJson: _intToBool) @Default(false) bool isOwner,
    @Default('candidate') String status,
    @Default(0) int documentCount,
    @Default(0) int transactionCount,
    @Default(0) int unresolvedAliasCount,
    @Default(0) int aliasCount,
    String? lastSeenAt,
    @Default([]) List<String> roles,
  }) = _Person;

  bool get confirmed => status == 'confirmed';

  factory Person.fromJson(Map<String, dynamic> json) =>
      _$PersonFromJson(json);
}

/// One alias row, typed and with provenance (work order 05 §B.2).
@freezed
abstract class PersonAlias with _$PersonAlias {
  const PersonAlias._();

  const factory PersonAlias({
    required int id,
    @Default('') String alias,
    @Default('name_variant') String aliasType,
    String? source,
    @Default('confirmed') String status,
    @Default('') String createdAt,
    String? lastSeenAt,
    @Default(0) int supportingDocuments,
  }) = _PersonAlias;

  bool get rejected => status == 'rejected';
  bool get proposed => status == 'proposed';

  factory PersonAlias.fromJson(Map<String, dynamic> json) =>
      _$PersonAliasFromJson(json);
}

/// The People-tab drill-down for one person (work order 05 §B.6).
@Freezed(toJson: false)
abstract class PersonDetail with _$PersonDetail {
  const factory PersonDetail({
    required Person person,
    @Default([]) List<PersonAlias> aliases,
    @Default([]) List<Map<String, dynamic>> documents,
    @Default([]) List<Txn> transactions,
    @Default([]) List<Map<String, dynamic>> questions,
  }) = _PersonDetail;

  factory PersonDetail.fromJson(Map<String, dynamic> json) =>
      _$PersonDetailFromJson(json);
}

// ════════════════════════════════════════════════════════════════════════
// Snapshot model
// ════════════════════════════════════════════════════════════════════════

@Freezed(fromJson: false)
abstract class Snapshot with _$Snapshot {
  const Snapshot._();

  const factory Snapshot({
    @Default(0) int spendingMinor,
    @Default(0) int incomeMinor,
    @Default(0) int transfersMinor,
    @Default(0) int investmentsMinor,
    @Default(0) int investmentsInMinor,
    @Default(0) int incomeDocs,
    @Default(0) int spendingDocs,
    @Default(0) int investmentDocs,
    @Default(0) int documents,
    @Default(0) int transactions,
    @Default(0) int entities,
    @Default(0) int evidenceLinks,
    @Default(Period(key: 'all', label: '')) Period period,
  }) = _Snapshot;

  static const empty = Snapshot();

  factory Snapshot.fromJson(Map<String, dynamic> j) {
    final c = (j['counts'] ?? const {}) as Map<String, dynamic>;
    return Snapshot(
      spendingMinor: (j['spending_minor'] ?? 0) as int,
      incomeMinor: (j['income_minor'] ?? 0) as int,
      transfersMinor: (j['transfers_minor'] ?? 0) as int,
      investmentsMinor: (j['investments_minor'] ?? 0) as int,
      investmentsInMinor: (j['investments_in_minor'] ?? 0) as int,
      incomeDocs: (j['income_documents'] ?? 0) as int,
      spendingDocs: (j['spending_documents'] ?? 0) as int,
      investmentDocs: (j['investment_documents'] ?? 0) as int,
      documents: (c['documents'] ?? 0) as int,
      transactions: (c['transactions'] ?? 0) as int,
      entities: (c['entities'] ?? 0) as int,
      evidenceLinks: (c['evidence_links'] ?? 0) as int,
      period: Period.fromJson(j['period'] as Map<String, dynamic>?),
    );
  }

  /// What a document-counting tool would have reported: every document's
  /// amount added up, including the ones that describe the same rupee.
  int naiveMinor(List<Txn> txns) => txns.fold(
        0,
        (a, t) =>
            a + t.amountMinor * (t.evidence.isEmpty ? 1 : t.evidence.length),
      );
}

// ════════════════════════════════════════════════════════════════════════
// Transaction / evidence models
// ════════════════════════════════════════════════════════════════════════

class Leg {
  final String leg;
  final int amountMinor;
  final String account;
  const Leg({
    required this.leg,
    required this.amountMinor,
    required this.account,
  });
  factory Leg.fromJson(Map<String, dynamic> j) => Leg(
    leg: (j['leg'] ?? '') as String,
    amountMinor: (j['amount_minor'] ?? 0) as int,
    account: (j['account'] ?? '') as String,
  );
  bool get isDebit => leg == 'debit';
}

class Evidence {
  final String id;
  final String filename;
  final String role;
  final double? matchScore;
  final String linkedBy;
  final Map<String, dynamic>? extraction;

  const Evidence({
    required this.id,
    required this.filename,
    required this.role,
    this.matchScore,
    this.linkedBy = 'ai',
    this.extraction,
  });

  factory Evidence.fromJson(Map<String, dynamic> j) => Evidence(
    id: (j['id'] ?? '') as String,
    filename: (j['original_filename'] ?? '') as String,
    role: (j['evidence_role'] ?? '') as String,
    matchScore: (j['match_score'] as num?)?.toDouble(),
    linkedBy: (j['linked_by'] ?? 'ai') as String,
    extraction: j['extraction'] as Map<String, dynamic>?,
  );

  Map<String, String> get refs {
    final r = extraction?['reference_ids'];
    if (r is! Map) return const {};
    return r.map((k, v) => MapEntry(k.toString(), v.toString()));
  }
}

class Txn {
  final String id;
  final String direction;
  final int amountMinor;

  /// ISO 4217 source currency, or null when the document stated none
  /// (work order 05 §A.2). Null is a REVIEW state — render it as
  /// "currency uncertain", never as a silent rupee figure.
  final String? currency;
  final int? homeAmountMinor;
  final double? fxRate;
  final String? fxDate;
  final String occurredAt;
  final String fyKey;
  final String? counterparty;
  final String? rail;
  final String status;

  /// How THIS document was linked to the transaction — ai | rule | user |
  /// import (work order 05 §Track C). Only present on rows returned inside a
  /// document detail payload.
  final String? linkedBy;

  /// WO12 phase 2: the transaction this refund reverses, or null when this
  /// transaction is not a refund. Set by recordTransaction when a refund_note
  /// matches an existing outbound transaction by amount and currency.
  final String? reversesTransactionId;
  final List<Leg> legs;
  final List<Evidence> evidence;

  const Txn({
    required this.id,
    required this.direction,
    required this.amountMinor,
    required this.occurredAt,
    required this.fyKey,
    this.currency,
    this.homeAmountMinor,
    this.fxRate,
    this.fxDate,
    this.counterparty,
    this.rail,
    this.status = 'evidenced',
    this.linkedBy,
    this.reversesTransactionId,
    this.legs = const [],
    this.evidence = const [],
  });

  factory Txn.fromJson(Map<String, dynamic> j) => Txn(
    id: (j['id'] ?? '') as String,
    direction: (j['direction'] ?? 'out') as String,
    amountMinor: (j['amount_minor'] ?? 0) as int,
    currency: (j['currency'] as String?)?.isNotEmpty == true
        ? (j['currency'] as String)
        : null,
    homeAmountMinor: (j['home_amount_minor'] as num?)?.toInt(),
    fxRate: (j['fx_rate'] as num?)?.toDouble(),
    fxDate: j['fx_date'] as String?,
    occurredAt: (j['occurred_at'] ?? '') as String,
    fyKey: (j['fy_key'] ?? '') as String,
    counterparty: j['counterparty_name'] as String?,
    rail: j['payment_rail'] as String?,
    status: (j['status'] ?? 'evidenced') as String,
    linkedBy: j['linked_by'] as String?,
    reversesTransactionId: j['reverses_transaction_id'] as String?,
    legs: ((j['legs'] ?? const []) as List)
        .map((e) => Leg.fromJson(e as Map<String, dynamic>))
        .toList(),
    evidence: ((j['evidence'] ?? const []) as List)
        .map((e) => Evidence.fromJson(e as Map<String, dynamic>))
        .toList(),
  );

  /// WO12 phase 2: true when this transaction is a refund that reverses
  /// another transaction. The UI shows a "Reverses" badge on such rows.
  bool get isRefund => reversesTransactionId != null;

  /// WO12 phase 2: true when the transaction has an invoice but no settlement
  /// evidence yet — the "Awaiting settlement" flag.
  bool get isAwaitingSettlement => status == 'awaiting_settlement';

  /// WO12 phase 2: true when a settlement document arrived with no invoice —
  /// the "No invoice on file" gap flag.
  bool get isNoInvoice => status == 'no_invoice';

  bool get isTransfer => direction == 'transfer';
  bool get multiEvidence => evidence.length > 1;

  /// Source evidence, always with its currency: "USD 597.85", "₹643.72".
  String get sourceAmount => money(amountMinor, currency);

  /// The converted home value, when one exists — a SEPARATE labelled figure,
  /// never a replacement for the source amount. The daemon's aggregates are
  /// INR-denominated today; when multi-jurisdiction lands this takes the
  /// pack's currency from the payload instead.
  String? get homeAmount =>
      homeAmountMinor == null ? null : money(homeAmountMinor!, 'INR');
}

class EvidenceCard {
  final Txn transaction;
  final List<Leg> legs;
  final List<Evidence> evidence;
  final List<Map<String, dynamic>> provenance;
  final String summary;

  const EvidenceCard({
    required this.transaction,
    required this.legs,
    required this.evidence,
    required this.provenance,
    required this.summary,
  });

  factory EvidenceCard.fromJson(Map<String, dynamic> j) => EvidenceCard(
    transaction: Txn.fromJson(j['transaction'] as Map<String, dynamic>),
    legs: ((j['legs'] ?? const []) as List)
        .map((e) => Leg.fromJson(e as Map<String, dynamic>))
        .toList(),
    evidence: ((j['evidence'] ?? const []) as List)
        .map((e) => Evidence.fromJson(e as Map<String, dynamic>))
        .toList(),
    provenance: ((j['provenance'] ?? const []) as List)
        .cast<Map<String, dynamic>>(),
    summary: (j['summary'] ?? '') as String,
  );

  /// Reference IDs appearing on MORE THAN ONE document — the join keys that
  /// collapsed several documents into one transaction. Highlighting these is
  /// the single most persuasive thing the UI does.
  Set<String> get sharedRefValues {
    final counts = <String, int>{};
    for (final e in evidence) {
      for (final v in e.refs.values.toSet()) {
        counts[v] = (counts[v] ?? 0) + 1;
      }
    }
    return counts.entries.where((e) => e.value > 1).map((e) => e.key).toSet();
  }
}

class VaultEvent {
  final String type;
  final Map<String, dynamic> data;
  final DateTime at;
  VaultEvent(this.type, this.data) : at = DateTime.now();
}

// ════════════════════════════════════════════════════════════════════════
// Health / daemon status
// ════════════════════════════════════════════════════════════════════════

/// Work order 07 §C1 — daemon health and capability handshake.
///
/// The client uses this to distinguish:
/// - **compatible**: daemon is reachable and its capabilities match what the
///   client needs.
/// - **outdated**: daemon is reachable but its schema_version or capabilities
///   are behind what the client expects. A stale daemon must not masquerade as
///   an empty vault.
/// - **unreachable**: daemon is not responding at all.
/// - **capability-unavailable**: daemon is reachable but a specific capability
///   the client needs (e.g. `irrelevant`) is false or missing.
@Freezed(fromJson: false)
abstract class HealthStatus with _$HealthStatus {
  const HealthStatus._();

  const factory HealthStatus({
    required bool isReachable,
    String? apiVersion,
    String? version,
    String? buildId,
    int? schemaVersion,
    @Default({}) Map<String, dynamic> capabilities,
    int? statusCode,
    String? error,
  }) = _HealthStatus;

  factory HealthStatus.fromJson(Map<String, dynamic> j) {
    final caps = j['capabilities'];
    return HealthStatus(
      isReachable: true,
      apiVersion: j['api_version'] as String?,
      version: j['version'] as String?,
      buildId: j['build_id'] as String?,
      schemaVersion: (j['schema_version'] as num?)?.toInt(),
      capabilities: caps is Map<String, dynamic>
          ? caps
          : caps is Map
              ? Map<String, dynamic>.from(caps)
              : const {},
    );
  }

  factory HealthStatus.unreachable({int? statusCode, String? error}) =>
      HealthStatus(isReachable: false, statusCode: statusCode, error: error);

  /// Whether a specific capability is advertised as available.
  bool hasCapability(String name) => capabilities[name] == true;

  /// Whether the daemon's schema version is at least [required].
  bool isSchemaCompatible(int required) =>
      schemaVersion != null && schemaVersion! >= required;

  @override
  String toString() => isReachable
      ? 'HealthStatus(ok, v=$version, schema=$schemaVersion, caps=${capabilities.keys.join(",")})'
      : 'HealthStatus(unreachable, status=$statusCode, error=$error)';
}

// ════════════════════════════════════════════════════════════════════════
// Intake events
// ════════════════════════════════════════════════════════════════════════

/// Work order 06 — one intake event with full disposition detail.
///
/// The daemon's intake_events row, surfaced to the Flutter intake feed and the
/// Irrelevant view. `kind` is the disposition: 'accepted' (was 'added'),
/// 'irrelevant', 'duplicate', or 'failed'. Every disposition has a reason.
@freezed
abstract class IntakeEvent with _$IntakeEvent {
  const IntakeEvent._();

  const factory IntakeEvent({
    required int id,
    @Default('failed') String kind,
    @Default('') String filename,
    String? sha256,
    String? documentId,
    @Default('folder') String source,
    String? detail,
    String? reasonCode,
    String? reason,
    String? confidence,
    String? matchedDocumentId,
    String? canonicalPath,
    @Default('received') String processingState,
    @JsonKey(fromJson: _flexibleBool) @Default(false) bool triageReview,
    @JsonKey(fromJson: _dateTimeOrNow) required DateTime createdAt,
    String? lastError,
    @Default(0) int retryCount,
    String? nextRetryAt,
    String? stageStartedAt,
    String? heartbeatAt,
    String? finishedAt,
    @Default(false) bool stalled,
  }) = _IntakeEvent;

  /// Normalised disposition: 'added' (legacy) → 'accepted'.
  String get disposition => kind == 'added' ? 'accepted' : kind;

  /// Work order 07 §B2: a user-readable terminal outcome, not raw job churn.
  /// Returns null if the item is not yet in a terminal state.
  String? get terminalOutcome {
    switch (processingState) {
      case 'complete':
        return 'Completed';
      case 'failed':
        return lastError != null ? 'Failed: $lastError' : 'Failed';
      case 'triaged':
        // Irrelevant/duplicate dispositions are terminal at triage.
        if (kind == 'irrelevant') return 'Irrelevant';
        if (kind == 'duplicate') return 'Duplicate';
        return null;
      default:
        return null;
    }
  }

  /// Work order 07 §B2: the current stage as a user-readable label.
  String get stageLabel {
    switch (processingState) {
      case 'received':
        return 'Received';
      case 'stable':
        return 'Waiting for stability';
      case 'hashed':
        return 'Hashed';
      case 'triaged':
        return 'Triaging';
      case 'archived':
        return 'Stored safely';
      case 'queued':
        return 'Queued';
      case 'processing':
        return detail ?? 'Processing';
      case 'complete':
        return 'Completed';
      case 'failed':
        return 'Failed';
      case 'password_needed':
        return 'Password required';
      default:
        return processingState;
    }
  }

  /// Work order 07 §G: true when the document is encrypted and waiting for
  /// the user to provide a password.
  bool get needsPassword => processingState == 'password_needed';

  factory IntakeEvent.fromJson(Map<String, dynamic> json) =>
      _$IntakeEventFromJson(json);
}

// ════════════════════════════════════════════════════════════════════════
// Exceptions
// ════════════════════════════════════════════════════════════════════════

/// The daemon rejected our credentials. Distinct from a transient network
/// failure because the remedy is different: retrying forever will not help,
/// and rendering zeros would be a lie — an unauthorised client knows nothing
/// about the vault, which is not the same as a vault containing nothing.
class VaultAuthException implements Exception {
  final int statusCode;
  final String path;
  const VaultAuthException(this.statusCode, this.path);
  @override
  String toString() => 'GET $path -> $statusCode (bad or missing API token)';
}

/// Raised when a rename would collide with an existing person. That is a
/// merge decision, not a rename, so the UI must ask rather than guess.
class PersonConflict implements Exception {
  PersonConflict(this.message, {this.existingId});
  final String message;
  final String? existingId;
  @override
  String toString() => message;
}

/// Raised when deleting a person who is still named on documents. Deleting
/// anyway would detach evidence from the ledger, so it requires force.
class PersonInUse implements Exception {
  PersonInUse(this.message, {required this.documents});
  final String message;
  final int documents;
  @override
  String toString() => message;
}

/// WO11 Track B — the document detail endpoint serves ACTIVE documents only.
/// A removed document answers 404 (`document_not_available` — Reprocess
/// brings it back); a deleted one answers 410 (`document_deleted` — the row
/// is a tombstone; ingesting the file again creates a fresh document).
class DocumentUnavailable implements Exception {
  DocumentUnavailable(this.documentId, {required this.kind});
  final String documentId;

  /// 'removed' or 'deleted'.
  final String kind;
  bool get reprocessable => kind == 'removed';
  @override
  String toString() => kind == 'deleted'
      ? 'This document was permanently deleted.'
      : 'This document was removed from the active ledger.';
}

/// Raised when /statement is called on a document that is not a statement —
/// the daemon's 400 not_a_statement, surfaced as a typed exception so the UI
/// can simply hide the card rather than showing a raw error string.
class NotAStatement implements Exception {
  NotAStatement(this.message);
  final String message;
  @override
  String toString() => message;
}

/// A refusal from the claims resolver — NOT a transport error.
///
/// The daemon returns 409 with a machine-readable code when an edit is
/// invalid rather than impossible: the field belongs to a different subject
/// scope, or a confirmed claim outranks the write. Surfacing the code lets
/// the UI say what actually happened instead of "something went wrong".
class ClaimRefusedException implements Exception {
  final String code;
  final String message;
  const ClaimRefusedException(this.code, this.message);

  @override
  String toString() => message;
}

// ════════════════════════════════════════════════════════════════════════
// VaultError — structured user-facing error mapping
// ════════════════════════════════════════════════════════════════════════

/// Work order 07 §C3 — structured user-facing error. Never show raw exception
/// strings. Map errors to a title, explanation, recovery action, and optional
/// technical disclosure.
///
/// Usage:
///   catch (e) { setState(() => _error = VaultError.from(e).message); }
///   catch (e) { _error = VaultError.from(e); }
///
/// The [technical] field is the raw exception string, available behind a
/// disclosure so a developer or support engineer can see what actually
/// happened without the user having to read it.
class VaultError {
  final String title;
  final String explanation;
  final String recovery;
  final String? technical;

  const VaultError({
    required this.title,
    required this.explanation,
    required this.recovery,
    this.technical,
  });

  /// A one-line message suitable for a snackbar or inline error.
  String get message => '$title — $recovery';

  @override
  String toString() => message;

  /// Map any caught exception to a user-facing error. Raw exception strings
  /// are never shown directly — they go into [technical].
  factory VaultError.from(Object e) {
    if (e is VaultAuthException) {
      return VaultError(
        title: 'Authentication failed',
        explanation: 'The daemon refused the API token (HTTP ${e.statusCode}).',
        recovery: 'Check the token in Settings and restart the daemon.',
        technical: e.toString(),
      );
    }
    if (e is PersonConflict) {
      return VaultError(
        title: 'Name already in use',
        explanation: e.message,
        recovery: 'Merge the two people instead of renaming.',
        technical: e.toString(),
      );
    }
    if (e is PersonInUse) {
      return VaultError(
        title: 'Person is named on documents',
        explanation: '${e.documents} document(s) reference this person.',
        recovery: 'Confirm force-delete or remove the references first.',
        technical: e.toString(),
      );
    }
    if (e is NotAStatement) {
      return VaultError(
        title: 'Not a statement',
        explanation: 'This document is not a bank or card statement.',
        recovery: 'Select a statement document to view its lines.',
        technical: e.toString(),
      );
    }
    if (e is ClaimRefusedException) {
      return VaultError(
        title: 'Claim refused',
        explanation: e.message,
        recovery: 'Adjust the claim and try again.',
        technical: e.toString(),
      );
    }
    // Generic fallback — never show the raw string as the primary message.
    final raw = e.toString();
    // Detect common network errors from the raw string.
    if (raw.contains('SocketException') || raw.contains('connection refused')) {
      return VaultError(
        title: 'Daemon unreachable',
        explanation: 'The daemon is not running or refused the connection.',
        recovery: 'Start the daemon or check it is listening.',
        technical: raw,
      );
    }
    if (raw.contains('TimeoutException') || raw.contains('timed out')) {
      return VaultError(
        title: 'Request timed out',
        explanation: 'The daemon did not respond in time.',
        recovery: 'Try again; if it persists, check daemon load.',
        technical: raw,
      );
    }
    return VaultError(
      title: 'Something went wrong',
      explanation: 'An unexpected error occurred.',
      recovery: 'Try again; if it persists, restart the daemon.',
      technical: raw,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// Learning models
// ════════════════════════════════════════════════════════════════════════

/// One open question from the curiosity engine, plus everything needed to
/// answer it as a durable rule rather than a one-off correction.
@freezed
abstract class LearningQuestion with _$LearningQuestion {
  const LearningQuestion._();

  const factory LearningQuestion({
    required int id,
    @Default('') String question,
    @Default('') String trigger,
    @Default({}) Map<String, dynamic> context,
    @Default([]) List<String> options,
    @JsonKey(fromJson: _nullableDateTime) DateTime? createdAt,
  }) = _LearningQuestion;

  /// The raw bank descriptor this question is about, when there is one.
  String? get descriptor => context['descriptor'] as String?;

  /// The resolved entity name the descriptor might be an alias of.
  String? get entityName => context['entity_name'] as String?;

  /// The document that triggered the question, for showing the evidence.
  String? get documentId => context['document_id'] as String?;

  factory LearningQuestion.fromJson(Map<String, dynamic> json) =>
      _$LearningQuestionFromJson(json);
}

/// A rule the vault has learned from an answer.
@freezed
abstract class LearnedRule with _$LearnedRule {
  const factory LearnedRule({
    required int id,
    @Default('') String kind,
    @Default('') String matchKey,
    @Default('') String value,
    @Default(0) int timesApplied,
  }) = _LearnedRule;

  factory LearnedRule.fromJson(Map<String, dynamic> json) =>
      _$LearnedRuleFromJson(json);
}

/// The whole learning surface in one shape.
@freezed
abstract class LearningState with _$LearningState {
  const LearningState._();

  const factory LearningState({
    @Default(true) bool enabled,
    @Default(0) int budget,
    @Default([]) List<LearningQuestion> questions,
    @Default([]) List<LearnedRule> rules,
    @Default(0) int answered,
  }) = _LearningState;

  static const empty = LearningState();

  factory LearningState.fromJson(Map<String, dynamic> json) =>
      _$LearningStateFromJson(json);
}

// ════════════════════════════════════════════════════════════════════════
// Document models
// ════════════════════════════════════════════════════════════════════════

/// A document as the browser list needs it: enough to group, label and show
/// pipeline state without fetching the file itself.
@freezed
abstract class VaultDoc with _$VaultDoc {
  const VaultDoc._();

  const factory VaultDoc({
    required String id,
    @JsonKey(name: 'original_filename', defaultValue: '(unnamed)')
    required String filename,
    String? ext,
    @Default(0) int byteSize,
    String? docType,
    String? source,
    @Default('') String receivedAt,
    String? analysedAt,
    @Default(0) int markdownChars,
  }) = _VaultDoc;

  /// True once analysis has run. Drives the green/amber dot in the list — the
  /// difference between "we have the bytes" and "we understand it".
  bool get analysed => analysedAt != null;

  /// Whether a markdown view is worth offering. Zero chars means conversion
  /// produced nothing, so the toggle would open an empty pane.
  bool get hasMarkdown => markdownChars > 0;

  /// Formats the daemon can serve as a magnifiable page image.
  ///
  /// Includes PDF: the daemon rasterises those server-side (/page), so from the
  /// client's point of view a PDF is just an image. Excludes .eml — an email
  /// body has no page to render, and its attachments are ingested as their own
  /// documents.
  static const pageableExtensions = {
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'heic',
    'pdf',
  };

  /// True when this document can be shown as a magnifiable page image.
  ///
  /// Single source of truth, on the model rather than in a widget: BOTH the
  /// default-view choice and the pane that renders it need this answer, and two
  /// independent copies of the extension list would eventually disagree — which
  /// shows up as a document defaulting to a view it cannot render.
  bool get hasPageImage => pageableExtensions.contains(
        (ext ?? '').toLowerCase().replaceFirst('.', ''),
      );

  factory VaultDoc.fromJson(Map<String, dynamic> json) =>
      _$VaultDocFromJson(json);
}

/// How a document can be shown, and how many pages it has.
///
/// Fetched separately from the image itself because Flutter's NetworkImage
/// exposes no response headers — the daemon's x-page-count is invisible to it,
/// so a viewer cannot otherwise know a PDF has more than one page.
@freezed
abstract class PageInfo with _$PageInfo {
  const PageInfo._();

  const factory PageInfo({
    @Default('none') String kind,
    @Default(0) int pages,
    @Default(false) bool pagerAvailable,
    String? reason,
  }) = _PageInfo;

  bool get hasImage => kind != 'none';

  /// A pager is only worth showing when there is more than one page AND the
  /// daemon can actually render the others.
  bool get showPager => pages > 1 && pagerAvailable;

  static const none = PageInfo();

  factory PageInfo.fromJson(Map<String, dynamic> json) =>
      _$PageInfoFromJson(json);
}

/// One effective field value on the evidence summary: the winning value and
/// who said so (ai | rule | user | import), or null when nothing claims it.
@freezed
abstract class EffectiveValue with _$EffectiveValue {
  const factory EffectiveValue({
    @Default('') String value,
    @Default('ai') String source,
    @Default('proposed') String status,
  }) = _EffectiveValue;

  factory EffectiveValue.fromJson(Map<String, dynamic> json) =>
      _$EffectiveValueFromJson(json);
}

/// The document evidence summary (work order 05 §A.3).
@Freezed(fromJson: false, toJson: false)
abstract class DocumentDetail with _$DocumentDetail {
  const DocumentDetail._();

  const factory DocumentDetail({
    @Default({}) Map<String, dynamic> document,
    Map<String, dynamic>? extraction,
    @Default({}) Map<String, EffectiveValue> effective,
    @Default({}) Map<String, Map<String, dynamic>> claims,
    @Default({}) Map<String, dynamic> referenceIds,
    int? subtotalMinor,
    int? taxMinor,
    @Default([]) List<Map<String, dynamic>> lineItems,
    @Default([]) List<Map<String, dynamic>> parties,
    @Default([]) List<Txn> transactions,
    @Default({}) Set<String> editableFields,
  }) = _DocumentDetail;

  EffectiveValue? operator [](String field) => effective[field];

  factory DocumentDetail.fromJson(Map<String, dynamic> j) {
    final eff = <String, EffectiveValue>{};
    final rawRaw = j['effective'];
    final raw = rawRaw is Map
        ? Map<String, dynamic>.from(rawRaw)
        : <String, dynamic>{};
    for (final e in raw.entries) {
      if (e.value is Map) {
        eff[e.key] =
            EffectiveValue.fromJson(Map<String, dynamic>.from(e.value as Map));
      }
    }
    final claimsRaw = j['claims'];
    final claims = <String, Map<String, dynamic>>{};
    if (claimsRaw is Map) {
      for (final e in claimsRaw.entries) {
        if (e.value is Map) {
          claims[e.key.toString()] = Map<String, dynamic>.from(e.value as Map);
        }
      }
    }
    return DocumentDetail(
      document: j['document'] is Map
          ? Map<String, dynamic>.from(j['document'] as Map)
          : const {},
      extraction: j['extraction'] is Map
          ? Map<String, dynamic>.from(j['extraction'] as Map)
          : null,
      effective: eff,
      claims: claims,
      referenceIds: raw['reference_ids'] is Map
          ? Map<String, dynamic>.from(raw['reference_ids'] as Map)
          : const {},
      subtotalMinor: (raw['subtotal_minor'] as num?)?.toInt(),
      taxMinor: (raw['tax_minor'] as num?)?.toInt(),
      lineItems: ((raw['line_items'] ?? const []) as List)
          .whereType<Map>()
          .map(Map<String, dynamic>.from)
          .toList(),
      parties: ((j['parties'] ?? const []) as List)
          .whereType<Map>()
          .map(Map<String, dynamic>.from)
          .toList(),
      transactions: ((j['transactions'] ?? const []) as List)
          .map((e) => Txn.fromJson(e as Map<String, dynamic>))
          .toList(),
      editableFields: ((j['editable_fields'] ?? const []) as List)
          .cast<String>()
          .toSet(),
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// Reset result
// ════════════════════════════════════════════════════════════════════════

/// What a vault reset destroyed. `note` carries the daemon's reminder that
/// documents on disk were left alone.
@Freezed(fromJson: false)
abstract class ResetResult with _$ResetResult {
  const factory ResetResult({
    @Default('ledger') String scope,
    @Default(0) int documents,
    @Default(0) int transactions,
    @Default(0) int entities,
    @Default(0) int learnedRules,
    @Default('') String note,
  }) = _ResetResult;

  factory ResetResult.fromJson(Map<String, dynamic> j) {
    final c = (j['cleared'] as Map<String, dynamic>?) ?? const {};
    int n(String k) => (c[k] as num?)?.toInt() ?? 0;
    return ResetResult(
      scope: (j['scope'] as String?) ?? 'ledger',
      documents: n('documents'),
      transactions: n('transactions'),
      entities: n('entities'),
      learnedRules: n('learned_rules'),
      note: (j['note'] as String?) ?? '',
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// Statement models
// ════════════════════════════════════════════════════════════════════════

/// One line of a bank/card statement, as staged and reconciled by the daemon
/// (work order 04 §Track A). `status` mirrors what the reconciler DECIDED,
/// not a re-derived guess: 'linked' settled an existing transaction,
/// 'created' promoted a new one (a gap — no invoice was ever on file),
/// 'pending' is still waiting on the review queue.
@freezed
abstract class StatementLine with _$StatementLine {
  const StatementLine._();

  const factory StatementLine({
    @Default('') String id,
    @Default(0) int lineNo,
    String? occurredAt,
    @Default('') String rawDescriptor,
    @Default(0) int amountMinor,
    @Default('out') String direction,
    int? balanceAfterMinor,
    @Default('INR') String currency,
    @JsonKey(fromJson: _fxOriginalFromJson, toJson: _fxOriginalToJson)
    FxOriginal? fxOriginal,
    String? referenceId,
    @Default('pending') String status,
    String? transactionId,
    String? transactionStatus,
    String? counterpartyName,
  }) = _StatementLine;

  /// True when this line is the "gap" the whole feature exists to surface —
  /// a genuine card/bank charge with no invoice ever seen for it.
  bool get isGap => status == 'created' && transactionStatus == 'no_invoice';

  factory StatementLine.fromJson(Map<String, dynamic> json) =>
      _$StatementLineFromJson(json);
}

/// The statement import summary card (work order 04 §A.6): N lines read, M
/// linked to existing transactions, K created new, G gaps — plus every line
/// for the drill-down list.
@Freezed(fromJson: false)
abstract class StatementSummary with _$StatementSummary {
  const factory StatementSummary({
    @Default('') String documentId,
    @Default('') String docType,
    @Default(0) int total,
    @Default(0) int linked,
    @Default(0) int created,
    @Default(0) int pending,
    @Default(0) int gaps,
    @Default([]) List<StatementLine> lines,
  }) = _StatementSummary;

  factory StatementSummary.fromJson(Map<String, dynamic> j) {
    final s = (j['summary'] ?? const {}) as Map<String, dynamic>;
    return StatementSummary(
      documentId: (j['document_id'] ?? '') as String,
      docType: (j['doc_type'] ?? '') as String,
      total: (s['total'] as num?)?.toInt() ?? 0,
      linked: (s['linked'] as num?)?.toInt() ?? 0,
      created: (s['created'] as num?)?.toInt() ?? 0,
      pending: (s['pending'] as num?)?.toInt() ?? 0,
      gaps: (s['gaps'] as num?)?.toInt() ?? 0,
      lines: ((j['lines'] as List?) ?? const [])
          .map((e) => StatementLine.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// Search
// ════════════════════════════════════════════════════════════════════════

/// One search result.
@freezed
abstract class SearchHit with _$SearchHit {
  const factory SearchHit({
    required String documentId,
    @JsonKey(defaultValue: '(unnamed)') required String filename,
    @Default('') String snippet,
    @Default(0) double rank,
    String? docType,
    String? transactionId,
    int? amountMinor,
    @JsonKey(fromJson: _currencyFromJson) String? currency,
    String? occurredAt,
  }) = _SearchHit;

  factory SearchHit.fromJson(Map<String, dynamic> json) =>
      _$SearchHitFromJson(json);
}

// ════════════════════════════════════════════════════════════════════════
// Claims models
// ════════════════════════════════════════════════════════════════════════

/// The winning claim for one field, with its provenance.
@freezed
abstract class FieldClaim with _$FieldClaim {
  const FieldClaim._();

  const factory FieldClaim({
    String? value,
    @Default('ai') String source,
    @Default('proposed') String status,
    double? confidence,
    String? at,
  }) = _FieldClaim;

  bool get isUser => source == 'user';

  factory FieldClaim.fromJson(Map<String, dynamic> json) =>
      _$FieldClaimFromJson(json);
}

/// Every live claim on one subject, plus which fields may be edited.
///
/// [editableFields] comes from the daemon rather than being duplicated in the
/// client: scope rules are enforced server-side, and a hardcoded client list
/// would drift into offering edits the vault then refuses.
@freezed
abstract class ClaimSet with _$ClaimSet {
  const ClaimSet._();

  const factory ClaimSet({
    @Default('') String subjectType,
    @Default('') String subjectId,
    @JsonKey(fromJson: _stringSetFromJson, toJson: _stringSetToJson)
    @Default({})
    Set<String> editableFields,
    @Default({}) Map<String, FieldClaim> claims,
  }) = _ClaimSet;

  static const empty = ClaimSet();

  FieldClaim? operator [](String field) => claims[field];

  factory ClaimSet.fromJson(Map<String, dynamic> json) =>
      _$ClaimSetFromJson(json);
}

/// A transaction the resolver touched after an edit.
@Freezed(toJson: false)
abstract class AffectedTransaction with _$AffectedTransaction {
  const factory AffectedTransaction({
    required String transactionId,
    @Default([]) List<String> changed,
    @JsonKey(fromJson: _stringMapFromJson, toJson: _stringMapToJson)
    @Default({})
    Map<String, String> reasons,
    @Default([]) List<ClaimMismatch> mismatches,
  }) = _AffectedTransaction;

  factory AffectedTransaction.fromJson(Map<String, dynamic> json) =>
      _$AffectedTransactionFromJson(json);
}

class ClaimMismatch {
  final String field;
  final String documentId;
  final String documentValue;
  final String canonical;

  const ClaimMismatch({
    required this.field,
    required this.documentId,
    required this.documentValue,
    required this.canonical,
  });

  factory ClaimMismatch.fromJson(Map<String, dynamic> j) => ClaimMismatch(
    field: j['field'] as String,
    documentId: (j['document_id'] as String?) ?? '',
    documentValue: (j['document_value'] ?? '').toString(),
    canonical: (j['canonical'] ?? '').toString(),
  );
}

class ClaimWriteResult {
  final int claimId;
  final String field;
  final String? value;
  final String? previous;
  final List<AffectedTransaction> affected;

  const ClaimWriteResult({
    required this.claimId,
    required this.field,
    required this.affected,
    this.value,
    this.previous,
  });

  factory ClaimWriteResult.fromJson(Map<String, dynamic> j) => ClaimWriteResult(
    claimId: (j['claim_id'] as num?)?.toInt() ?? 0,
    field: (j['field'] as String?) ?? '',
    value: j['value'] as String?,
    previous: j['previous'] as String?,
    affected: ((j['affected_transactions'] ?? const []) as List)
        .map((e) => AffectedTransaction.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

class AuditEntry {
  final int id;
  final String field;
  final String action;
  final String? oldValue;
  final String? newValue;
  final String source;
  final String at;

  const AuditEntry({
    required this.id,
    required this.field,
    required this.action,
    required this.source,
    required this.at,
    this.oldValue,
    this.newValue,
  });

  factory AuditEntry.fromJson(Map<String, dynamic> j) => AuditEntry(
    id: (j['id'] as num?)?.toInt() ?? 0,
    field: (j['field'] as String?) ?? '',
    action: (j['action'] as String?) ?? 'edit',
    oldValue: j['old_value'] as String?,
    newValue: j['new_value'] as String?,
    source: (j['source'] as String?) ?? 'user',
    at: (j['at'] as String?) ?? '',
  );
}
