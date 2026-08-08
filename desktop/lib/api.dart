/// Core API client — the Flutter app is a CLIENT of the daemon, exactly like
/// the web UI and the MCP server. It owns no database and no business logic.
///
/// This is the whole point of the daemon architecture (plan §1): the UI is
/// replaceable, and swapping React for Flutter changes nothing below this file.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// One tile of the spending treemap: a category, its total, and the raw
/// impact_buckets that were folded into it (kept so the fold is auditable
/// in a tooltip rather than being an invisible transformation).
class TreemapSource {
  final String bucket;
  final int amountMinor;
  final int transactions;
  const TreemapSource({
    required this.bucket,
    required this.amountMinor,
    required this.transactions,
  });
  factory TreemapSource.fromJson(Map<String, dynamic> j) => TreemapSource(
        bucket: (j['bucket'] ?? '') as String,
        amountMinor: (j['amount_minor'] ?? 0) as int,
        transactions: (j['transactions'] ?? 0) as int,
      );
}

class TreemapNode {
  final String id;
  final String label;
  final int amountMinor;
  final int transactions;
  final bool known;
  final List<TreemapSource> sources;
  const TreemapNode({
    required this.id,
    required this.label,
    required this.amountMinor,
    required this.transactions,
    required this.known,
    this.sources = const [],
  });
  factory TreemapNode.fromJson(Map<String, dynamic> j) => TreemapNode(
        id: (j['id'] ?? '') as String,
        label: (j['label'] ?? '') as String,
        amountMinor: (j['amount_minor'] ?? 0) as int,
        transactions: (j['transactions'] ?? 0) as int,
        known: j['known'] == true,
        sources: ((j['sources'] ?? const []) as List)
            .map((e) => TreemapSource.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class TreemapData {
  final List<TreemapNode> nodes;
  final int totalMinor;
  final int rawBuckets;
  const TreemapData({
    required this.nodes,
    required this.totalMinor,
    required this.rawBuckets,
  });
  static const empty = TreemapData(nodes: [], totalMinor: 0, rawBuckets: 0);
  factory TreemapData.fromJson(Map<String, dynamic> j) => TreemapData(
        nodes: ((j['nodes'] ?? const []) as List)
            .map((e) => TreemapNode.fromJson(e as Map<String, dynamic>))
            .toList(),
        totalMinor: (j['total_minor'] ?? 0) as int,
        rawBuckets: (j['raw_buckets'] ?? 0) as int,
      );
}

/// The period a snapshot covers, as resolved by the daemon.
class Period {
  final String key;
  final String label;
  final String? from;
  final String? to;
  const Period({required this.key, required this.label, this.from, this.to});

  factory Period.fromJson(Map<String, dynamic>? j) => Period(
        key: (j?['key'] ?? 'all') as String,
        label: (j?['label'] ?? '') as String,
        from: j?['from'] as String?,
        to: j?['to'] as String?,
      );
}

/// What the period selector should offer — months and financial years are
/// derived from the data, so an empty month is never shown.
class Periods {
  final String currentFy;
  final String currentMonth;
  final List<({String key, String label})> quick;
  final List<String> months;
  final List<String> financialYears;

  const Periods({
    required this.currentFy,
    required this.currentMonth,
    required this.quick,
    required this.months,
    required this.financialYears,
  });

  static const empty = Periods(
    currentFy: '', currentMonth: '', quick: [], months: [], financialYears: [],
  );

  factory Periods.fromJson(Map<String, dynamic> j) => Periods(
        currentFy: (j['current_fy'] ?? '') as String,
        currentMonth: (j['current_month'] ?? '') as String,
        quick: ((j['quick'] ?? const []) as List)
            .map((e) => (
                  key: (e['key'] ?? '') as String,
                  label: (e['label'] ?? '') as String,
                ))
            .toList(),
        months: ((j['months'] ?? const []) as List).cast<String>(),
        financialYears: ((j['financial_years'] ?? const []) as List).cast<String>(),
      );
}

/// A human the vault knows about. `isMember` marks people who share this
/// vault (self, spouse); everyone else is a counterparty-adjacent person such
/// as a landlord or tenant.
class Person {
  final String id;
  final String displayName;
  final String? relationship;
  final bool isMember;
  final String status;
  final int documentCount;
  final List<String> roles;

  const Person({
    required this.id,
    required this.displayName,
    this.relationship,
    this.isMember = false,
    this.status = 'candidate',
    this.documentCount = 0,
    this.roles = const [],
  });

  bool get confirmed => status == 'confirmed';

  factory Person.fromJson(Map<String, dynamic> j) => Person(
        id: (j['id'] ?? '') as String,
        displayName: (j['display_name'] ?? '') as String,
        relationship: j['subtype'] as String?,
        isMember: (j['is_member'] ?? 0) == 1,
        status: (j['status'] ?? 'candidate') as String,
        documentCount: (j['document_count'] ?? 0) as int,
        roles: ((j['roles'] ?? const []) as List).cast<String>(),
      );
}

class Snapshot {
  final int spendingMinor;
  final int incomeMinor;
  final int transfersMinor;
  final int investmentsMinor;
  final int investmentsInMinor;
  final int incomeDocs;
  final int spendingDocs;
  final int investmentDocs;
  final int documents;
  final int transactions;
  final int entities;
  final int evidenceLinks;
  final Period period;

  const Snapshot({
    required this.spendingMinor,
    required this.incomeMinor,
    required this.transfersMinor,
    this.investmentsMinor = 0,
    this.investmentsInMinor = 0,
    this.incomeDocs = 0,
    this.spendingDocs = 0,
    this.investmentDocs = 0,
    required this.documents,
    required this.transactions,
    required this.entities,
    required this.evidenceLinks,
    this.period = const Period(key: 'all', label: ''),
  });

  static const empty = Snapshot(
    spendingMinor: 0, incomeMinor: 0, transfersMinor: 0,
    documents: 0, transactions: 0, entities: 0, evidenceLinks: 0,
  );

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
  int naiveMinor(List<Txn> txns) =>
      txns.fold(0, (a, t) => a + t.amountMinor * (t.evidence.isEmpty ? 1 : t.evidence.length));
}

class Leg {
  final String leg;
  final int amountMinor;
  final String account;
  const Leg({required this.leg, required this.amountMinor, required this.account});
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
  final String occurredAt;
  final String fyKey;
  final String? counterparty;
  final String? rail;
  final String status;
  final List<Leg> legs;
  final List<Evidence> evidence;

  const Txn({
    required this.id,
    required this.direction,
    required this.amountMinor,
    required this.occurredAt,
    required this.fyKey,
    this.counterparty,
    this.rail,
    this.status = 'evidenced',
    this.legs = const [],
    this.evidence = const [],
  });

  factory Txn.fromJson(Map<String, dynamic> j) => Txn(
        id: (j['id'] ?? '') as String,
        direction: (j['direction'] ?? 'out') as String,
        amountMinor: (j['amount_minor'] ?? 0) as int,
        occurredAt: (j['occurred_at'] ?? '') as String,
        fyKey: (j['fy_key'] ?? '') as String,
        counterparty: j['counterparty_name'] as String?,
        rail: j['payment_rail'] as String?,
        status: (j['status'] ?? 'evidenced') as String,
        legs: ((j['legs'] ?? const []) as List)
            .map((e) => Leg.fromJson(e as Map<String, dynamic>))
            .toList(),
        evidence: ((j['evidence'] ?? const []) as List)
            .map((e) => Evidence.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  bool get isTransfer => direction == 'transfer';
  bool get multiEvidence => evidence.length > 1;
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

/// One open question from the curiosity engine, plus everything needed to
/// answer it as a durable rule rather than a one-off correction.
class LearningQuestion {
  final int id;
  final String question;
  /// Why this was asked: 'unseen_entity', 'ambiguous_category', etc. Decides
  /// which rule kind an answer becomes.
  final String trigger;
  final Map<String, dynamic> context;
  final List<String> options;
  final DateTime? createdAt;

  const LearningQuestion({
    required this.id,
    required this.question,
    required this.trigger,
    this.context = const {},
    this.options = const [],
    this.createdAt,
  });

  /// The raw bank descriptor this question is about, when there is one.
  String? get descriptor => context['descriptor'] as String?;

  /// The resolved entity name the descriptor might be an alias of.
  String? get entityName => context['entity_name'] as String?;

  /// The document that triggered the question, for showing the evidence.
  String? get documentId => context['document_id'] as String?;

  factory LearningQuestion.fromJson(Map<String, dynamic> j) => LearningQuestion(
        id: (j['id'] ?? 0) as int,
        question: (j['question'] ?? '') as String,
        trigger: (j['trigger'] ?? '') as String,
        context: (j['context'] as Map<String, dynamic>?) ?? const {},
        options: ((j['options'] ?? const []) as List).cast<String>(),
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'] as String),
      );
}

/// A rule the vault has learned from an answer.
class LearnedRule {
  final int id;
  final String kind;
  final String matchKey;
  final String value;
  final int timesApplied;

  const LearnedRule({
    required this.id,
    required this.kind,
    required this.matchKey,
    required this.value,
    required this.timesApplied,
  });

  factory LearnedRule.fromJson(Map<String, dynamic> j) => LearnedRule(
        id: (j['id'] ?? 0) as int,
        kind: (j['kind'] ?? '') as String,
        matchKey: (j['match_key'] ?? '') as String,
        value: (j['value'] ?? '') as String,
        timesApplied: (j['times_applied'] ?? 0) as int,
      );
}

/// The whole learning surface in one shape.
class LearningState {
  final bool enabled;
  final int budget;
  final List<LearningQuestion> questions;
  final List<LearnedRule> rules;
  /// How many questions have ever been answered — the vault's training count.
  final int answered;

  const LearningState({
    required this.enabled,
    required this.budget,
    required this.questions,
    required this.rules,
    required this.answered,
  });

  static const empty = LearningState(
    enabled: true, budget: 0, questions: [], rules: [], answered: 0,
  );

  factory LearningState.fromJson(Map<String, dynamic> j) => LearningState(
        enabled: (j['enabled'] ?? true) as bool,
        budget: (j['budget'] ?? 0) as int,
        questions: ((j['questions'] ?? const []) as List)
            .map((e) => LearningQuestion.fromJson(e as Map<String, dynamic>))
            .toList(),
        rules: ((j['rules'] ?? const []) as List)
            .map((e) => LearnedRule.fromJson(e as Map<String, dynamic>))
            .toList(),
        answered: (j['answered'] ?? 0) as int,
      );
}

/// A document as the browser list needs it: enough to group, label and show
/// pipeline state without fetching the file itself.
class VaultDoc {
  final String id;
  final String filename;
  final String? ext;
  final int byteSize;
  final String? docType;
  final String? source;
  final String receivedAt;
  final String? analysedAt;
  final int markdownChars;

  const VaultDoc({
    required this.id,
    required this.filename,
    required this.ext,
    required this.byteSize,
    required this.docType,
    required this.source,
    required this.receivedAt,
    required this.analysedAt,
    required this.markdownChars,
  });

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
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'pdf',
  };

  /// True when this document can be shown as a magnifiable page image.
  ///
  /// Single source of truth, on the model rather than in a widget: BOTH the
  /// default-view choice and the pane that renders it need this answer, and two
  /// independent copies of the extension list would eventually disagree — which
  /// shows up as a document defaulting to a view it cannot render.
  bool get hasPageImage => pageableExtensions
      .contains((ext ?? '').toLowerCase().replaceFirst('.', ''));

  factory VaultDoc.fromJson(Map<String, dynamic> j) => VaultDoc(
        id: j['id'] as String,
        filename: (j['original_filename'] ?? '(unnamed)') as String,
        ext: j['ext'] as String?,
        byteSize: (j['byte_size'] as num?)?.toInt() ?? 0,
        docType: j['doc_type'] as String?,
        source: j['source'] as String?,
        receivedAt: (j['received_at'] ?? '') as String,
        analysedAt: j['analysed_at'] as String?,
        markdownChars: (j['markdown_chars'] as num?)?.toInt() ?? 0,
      );
}

/// How a document can be shown, and how many pages it has.
///
/// Fetched separately from the image itself because Flutter's NetworkImage
/// exposes no response headers — the daemon's x-page-count is invisible to it,
/// so a viewer cannot otherwise know a PDF has more than one page.
class PageInfo {
  /// 'native' (serve as-is), 'rasterised' (rendered server-side), or 'none'.
  final String kind;
  final int pages;

  /// False when the daemon can only render page 1 (no pdftoppm installed).
  final bool pagerAvailable;

  /// Why there is no page image, for display verbatim.
  final String? reason;

  const PageInfo({
    required this.kind,
    required this.pages,
    required this.pagerAvailable,
    this.reason,
  });

  bool get hasImage => kind != 'none';

  /// A pager is only worth showing when there is more than one page AND the
  /// daemon can actually render the others.
  bool get showPager => pages > 1 && pagerAvailable;

  static const none =
      PageInfo(kind: 'none', pages: 0, pagerAvailable: false);

  factory PageInfo.fromJson(Map<String, dynamic> j) => PageInfo(
        kind: (j['kind'] as String?) ?? 'none',
        pages: (j['pages'] as num?)?.toInt() ?? 0,
        pagerAvailable: (j['pager_available'] as bool?) ?? false,
        reason: j['reason'] as String?,
      );
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

/// What a vault reset destroyed. `note` carries the daemon's reminder that
/// documents on disk were left alone.
class ResetResult {
  ResetResult({
    required this.scope,
    required this.documents,
    required this.transactions,
    required this.entities,
    required this.learnedRules,
    required this.note,
  });

  final String scope;
  final int documents;
  final int transactions;
  final int entities;
  final int learnedRules;
  final String note;

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

/// One line of a bank/card statement, as staged and reconciled by the daemon
/// (work order 04 §Track A). `status` mirrors what the reconciler DECIDED,
/// not a re-derived guess: 'linked' settled an existing transaction,
/// 'created' promoted a new one (a gap — no invoice was ever on file),
/// 'pending' is still waiting on the review queue.
class StatementLine {
  final String id;
  final int lineNo;
  final String? occurredAt;
  final String rawDescriptor;
  final int amountMinor;
  final String direction; // 'out' | 'in'
  final int? balanceAfterMinor;
  final String currency;
  final ({int amountMinor, String currency})? fxOriginal;
  final String? referenceId;
  final String status; // 'pending' | 'linked' | 'created' | 'skipped'
  final String? transactionId;
  final String? transactionStatus;
  final String? counterpartyName;

  const StatementLine({
    required this.id,
    required this.lineNo,
    required this.occurredAt,
    required this.rawDescriptor,
    required this.amountMinor,
    required this.direction,
    required this.balanceAfterMinor,
    required this.currency,
    required this.fxOriginal,
    required this.referenceId,
    required this.status,
    required this.transactionId,
    required this.transactionStatus,
    required this.counterpartyName,
  });

  /// True when this line is the "gap" the whole feature exists to surface —
  /// a genuine card/bank charge with no invoice ever seen for it.
  bool get isGap => status == 'created' && transactionStatus == 'no_invoice';

  factory StatementLine.fromJson(Map<String, dynamic> j) {
    final fx = j['fx_original'] as Map<String, dynamic>?;
    return StatementLine(
      id: (j['id'] ?? '') as String,
      lineNo: (j['line_no'] as num?)?.toInt() ?? 0,
      occurredAt: j['occurred_at'] as String?,
      rawDescriptor: (j['raw_descriptor'] ?? '') as String,
      amountMinor: (j['amount_minor'] as num?)?.toInt() ?? 0,
      direction: (j['direction'] ?? 'out') as String,
      balanceAfterMinor: (j['balance_after_minor'] as num?)?.toInt(),
      currency: (j['currency'] ?? 'INR') as String,
      fxOriginal: fx == null
          ? null
          : (amountMinor: (fx['amount_minor'] as num).toInt(), currency: fx['currency'] as String),
      referenceId: j['reference_id'] as String?,
      status: (j['status'] ?? 'pending') as String,
      transactionId: j['transaction_id'] as String?,
      transactionStatus: j['transaction_status'] as String?,
      counterpartyName: j['counterparty_name'] as String?,
    );
  }
}

/// The statement import summary card (work order 04 §A.6): N lines read, M
/// linked to existing transactions, K created new, G gaps — plus every line
/// for the drill-down list.
class StatementSummary {
  final String documentId;
  final String docType;
  final int total;
  final int linked;
  final int created;
  final int pending;
  final int gaps;
  final List<StatementLine> lines;

  const StatementSummary({
    required this.documentId,
    required this.docType,
    required this.total,
    required this.linked,
    required this.created,
    required this.pending,
    required this.gaps,
    required this.lines,
  });

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

/// One search result.
class SearchHit {
  final String documentId;
  final String filename;
  final String? docType;
  final String? transactionId;
  final int? amountMinor;
  final String? occurredAt;

  /// FTS5 snippet with matches wrapped in « » — the daemon picks the
  /// delimiters so no HTML/markdown escaping is needed on the client.
  final String snippet;
  final double rank;

  const SearchHit({
    required this.documentId,
    required this.filename,
    required this.snippet,
    required this.rank,
    this.docType,
    this.transactionId,
    this.amountMinor,
    this.occurredAt,
  });

  factory SearchHit.fromJson(Map<String, dynamic> j) => SearchHit(
        documentId: j['document_id'] as String,
        filename: (j['filename'] as String?) ?? '(unnamed)',
        snippet: (j['snippet'] as String?) ?? '',
        rank: (j['rank'] as num?)?.toDouble() ?? 0,
        docType: j['doc_type'] as String?,
        transactionId: j['transaction_id'] as String?,
        amountMinor: (j['amount_minor'] as num?)?.toInt(),
        occurredAt: j['occurred_at'] as String?,
      );
}

/// The winning claim for one field, with its provenance.
class FieldClaim {
  final String? value;

  /// user | rule | import | ai — drives the provenance badge.
  final String source;
  final String status;
  final double? confidence;
  final String? at;

  const FieldClaim({
    required this.source,
    required this.status,
    this.value,
    this.confidence,
    this.at,
  });

  bool get isUser => source == 'user';

  factory FieldClaim.fromJson(Map<String, dynamic> j) => FieldClaim(
        value: j['value'] as String?,
        source: (j['source'] as String?) ?? 'ai',
        status: (j['status'] as String?) ?? 'proposed',
        confidence: (j['confidence'] as num?)?.toDouble(),
        at: j['at'] as String?,
      );
}

/// Every live claim on one subject, plus which fields may be edited.
///
/// [editableFields] comes from the daemon rather than being duplicated in the
/// client: scope rules are enforced server-side, and a hardcoded client list
/// would drift into offering edits the vault then refuses.
class ClaimSet {
  final String subjectType;
  final String subjectId;
  final List<String> editableFields;
  final Map<String, FieldClaim> claims;

  const ClaimSet({
    required this.subjectType,
    required this.subjectId,
    required this.editableFields,
    required this.claims,
  });

  static const empty =
      ClaimSet(subjectType: '', subjectId: '', editableFields: [], claims: {});

  FieldClaim? operator [](String field) => claims[field];

  factory ClaimSet.fromJson(Map<String, dynamic> j) => ClaimSet(
        subjectType: (j['subject_type'] as String?) ?? '',
        subjectId: (j['subject_id'] as String?) ?? '',
        editableFields:
            ((j['editable_fields'] ?? const []) as List).cast<String>(),
        claims: ((j['claims'] ?? const {}) as Map<String, dynamic>).map(
          (k, v) =>
              MapEntry(k, FieldClaim.fromJson(v as Map<String, dynamic>)),
        ),
      );
}

/// A transaction the resolver touched after an edit.
class AffectedTransaction {
  final String transactionId;
  final List<String> changed;
  final Map<String, String> reasons;

  /// Documents that disagree with the canonical value. A populated list is
  /// not an error — it is the settlement-beats-invoice rule being visible.
  final List<ClaimMismatch> mismatches;

  const AffectedTransaction({
    required this.transactionId,
    required this.changed,
    required this.reasons,
    required this.mismatches,
  });

  factory AffectedTransaction.fromJson(Map<String, dynamic> j) =>
      AffectedTransaction(
        transactionId: j['transaction_id'] as String,
        changed: ((j['changed'] ?? const []) as List).cast<String>(),
        reasons: ((j['reasons'] ?? const {}) as Map<String, dynamic>)
            .map((k, v) => MapEntry(k, v.toString())),
        mismatches: ((j['mismatches'] ?? const []) as List)
            .map((e) => ClaimMismatch.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
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

  factory ClaimWriteResult.fromJson(Map<String, dynamic> j) =>
      ClaimWriteResult(
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

class VaultApi {
  final String baseUrl;
  final String token;
  final http.Client _client;

  VaultApi({required this.baseUrl, required this.token, http.Client? client})
      : _client = client ?? http.Client();

  Map<String, String> get _headers => {'authorization': 'Bearer $token'};

  /// Headers for loading a document image via Image.network.
  ///
  /// Exposed because the file route requires Bearer auth — query-string tokens
  /// are refused everywhere except /v1/events (they leak into logs, history and
  /// Referer headers). Image.network takes explicit headers, so the preview can
  /// authenticate without a URL token.
  Map<String, String> get imageHeaders => _headers;

  /// The document list for the Review browser.
  Future<List<VaultDoc>> documents({int limit = 200}) => _get(
        '/v1/documents?limit=$limit',
        (j) => ((j['documents'] ?? const []) as List)
            .map((e) => VaultDoc.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// URL for a document's original bytes. Needs [imageHeaders] to fetch.
  Uri documentFileUrl(String id) => Uri.parse('$baseUrl/v1/documents/$id/file');

  /// URL for a magnifiable PAGE IMAGE — the preview source.
  ///
  /// Prefer this over [documentFileUrl] for display: the daemon rasterises PDFs
  /// server-side and caches the result, so the client needs no PDF plugin and
  /// treats every previewable document identically.
  ///
  /// Width defaults to the daemon's own default (2400px) by omission, so the
  /// resolution decision lives in ONE place rather than being duplicated here.
  Uri documentPageUrl(String id, {int page = 1, int? width}) => Uri.parse(
      '$baseUrl/v1/documents/$id/page?n=$page${width == null ? '' : '&w=$width'}');

  /// Page count and render capability for a document.
  ///
  /// Never throws for an unpageable document — a 409 means "no page image",
  /// which is a legitimate answer (an email with no attachment), not a failure.
  Future<PageInfo> pageInfo(String id) async {
    final res = await _client
        .get(Uri.parse('$baseUrl/v1/documents/$id/pageinfo'), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultAuthException(res.statusCode, '/v1/documents/$id/pageinfo');
    }
    if (res.statusCode != 200) return PageInfo.none;
    return PageInfo.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// The extracted text, for the Document/Markdown toggle.
  ///
  /// Returns null rather than throwing when conversion has not run (409): an
  /// unconverted document is a normal state, not an error, and the caller shows
  /// "not converted yet" instead of an error banner.
  Future<String?> documentMarkdown(String id) async {
    final res = await _client
        .get(Uri.parse('$baseUrl/v1/documents/$id/markdown'), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultAuthException(res.statusCode, '/v1/documents/$id/markdown');
    }
    if (res.statusCode == 409 || res.statusCode == 410) return null;
    if (res.statusCode != 200) {
      throw Exception('GET /v1/documents/$id/markdown -> ${res.statusCode}');
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return j['markdown'] as String?;
  }

  Future<T> _get<T>(String path, T Function(Map<String, dynamic>) parse) async {
    final res = await _client
        .get(Uri.parse('$baseUrl$path'), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultAuthException(res.statusCode, path);
    }
    if (res.statusCode != 200) {
      throw Exception('GET $path -> ${res.statusCode}');
    }
    return parse(jsonDecode(res.body) as Map<String, dynamic>);
  }

  Future<bool> health() async {
    try {
      final res = await _client
          .get(Uri.parse('$baseUrl/v1/health'))
          .timeout(const Duration(seconds: 3));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Totals for a period. `period` is a quick key (this_month, last_month,
  /// this_fy, last_fy, all) or null for the default (this financial year).
  /// `month` (YYYY-MM) and `fy` select an explicit one.
  Future<Snapshot> snapshot({String? period, String? month, String? fy}) {
    final q = <String, String>{
      if (period case final p?) 'period': p,
      if (month case final m?) 'month': m,
      if (fy case final f?) 'fy': f,
    };
    final qs = q.isEmpty
        ? ''
        : '?${q.entries.map((e) => '${e.key}=${Uri.encodeComponent(e.value)}').join('&')}';
    return _get('/v1/snapshot$qs', Snapshot.fromJson);
  }

  /// Which periods this vault actually has data for.
  Future<Periods> periods() => _get('/v1/periods', Periods.fromJson);

  /// Spending by category for the same period the snapshot covers. The daemon
  /// folds raw impact_buckets onto the user's taxonomy, so the treemap total
  /// always equals the snapshot's spending figure.
  Future<TreemapData> treemap({String? period, String? month, String? fy}) {
    final q = <String, String>{
      if (period case final p?) 'period': p,
      if (month case final m?) 'month': m,
      if (fy case final f?) 'fy': f,
    };
    final qs = q.isEmpty
        ? ''
        : '?${q.entries.map((e) => '${e.key}=${Uri.encodeComponent(e.value)}').join('&')}';
    return _get('/v1/treemap$qs', TreemapData.fromJson);
  }

  /// The ledger for a period. Must be given the SAME period as the snapshot —
  /// a list from a different window than the totals above it is what made the
  /// period buttons look broken.
  ///
  /// [bucket] narrows the list to the transactions that produced one hero
  /// figure: 'income', 'spending', 'investments' or 'transfers'. The daemon
  /// applies the same predicates snapshot() uses, so the list always sums to
  /// the figure it explains.
  Future<List<Txn>> transactions({
    String? period,
    String? month,
    String? fy,
    String? bucket,
  }) {
    final q = <String, String>{};
    if (period != null) q['period'] = period;
    if (month != null) q['month'] = month;
    if (fy != null) q['fy'] = fy;
    if (bucket != null) q['bucket'] = bucket;
    final qs = q.isEmpty ? '' : '?${Uri(queryParameters: q).query}';
    return _get('/v1/transactions$qs', (j) =>
        ((j['transactions'] ?? const []) as List)
            .map((e) => Txn.fromJson(e as Map<String, dynamic>))
            .toList());
  }

  Future<EvidenceCard> evidenceCard(String txnId) =>
      _get('/v1/transactions/$txnId/evidence', EvidenceCard.fromJson);

  Future<List<Map<String, dynamic>>> intakeFeed() => _get('/v1/intake-feed',
      (j) => ((j['events'] ?? const []) as List).cast<Map<String, dynamic>>());

  Future<List<Map<String, dynamic>>> entities() => _get('/v1/entities',
      (j) => ((j['entities'] ?? const []) as List).cast<Map<String, dynamic>>());

  Future<List<Map<String, dynamic>>> reviews() => _get('/v1/reviews',
      (j) => ((j['reviews'] ?? const []) as List).cast<Map<String, dynamic>>());

  /// People the vault knows about, with the owner first.
  Future<({List<Person> people, Person? owner})> people() async {
    final j = await _get('/v1/people', (x) => x);
    final list = ((j['people'] ?? const []) as List)
        .map((e) => Person.fromJson(e as Map<String, dynamic>))
        .toList();
    return (
      people: list,
      owner: list.where((p) => p.isMember).firstOrNull,
    );
  }

  /// Declare a person, or update an existing one.
  Future<Map<String, dynamic>> savePerson({
    required String displayName,
    String? relationship,
    bool isMember = false,
    bool isOwner = false,
  }) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/people'),
      headers: {..._headers, 'content-type': 'application/json'},
      body: jsonEncode({
        'display_name': displayName,
        if (relationship != null && relationship.isNotEmpty) 'relationship': relationship,
        'is_member': isMember,
        'is_owner': isOwner,
      }),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Begin Gmail authorisation. Returns the consent URL — the daemon also
  /// opens it, but a URL the user can click is the reliable path.
  Future<({String? authUrl, String? error, String? detail})> gmailConnect() async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/gmail/connect'),
      headers: _headers,
    );
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return (
      authUrl: j['auth_url'] as String?,
      error: j['error'] as String?,
      detail: j['detail'] as String?,
    );
  }

  Future<Map<String, dynamic>> gmailSync() async {
    final res = await _client.post(Uri.parse('$baseUrl/v1/gmail/sync'), headers: _headers);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<void> gmailDisconnect() async {
    await _client.post(Uri.parse('$baseUrl/v1/gmail/disconnect'), headers: _headers);
  }

  /// Learning state: open questions and whether the engine is on.
  ///
  /// Kept returning a record for existing callers; use [learningState] for the
  /// typed shape the review screen needs.
  Future<({bool enabled, int budget, List<Map<String, dynamic>> questions})> learning() async {
    final j = await _get('/v1/learning', (x) => x);
    return (
      enabled: j['enabled'] == true,
      budget: (j['budget'] ?? 0) as int,
      questions: ((j['questions'] ?? const []) as List).cast<Map<String, dynamic>>(),
    );
  }

  /// The full learning surface: open questions, learned rules, training count.
  Future<LearningState> learningState() =>
      _get('/v1/learning', LearningState.fromJson);

  /// Answer a question. Passing a rule makes the answer DURABLE — the whole
  /// point of Learning Mode is that one correction teaches the vault forever
  /// instead of fixing a single row.
  ///
  /// Returns the created rule's id when a rule was made. The daemon responds
  /// `{answered: true, rule_id: N}` — verified against the live endpoint, not
  /// assumed — and omits rule_id when the answer created no rule.
  Future<({bool answered, int? ruleId})> answerLearning(
    int reviewId,
    String answer, {
    String? ruleKind,
    String? matchKey,
    String? matchKind,
    String? value,
  }) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/learning/answer'),
      headers: {..._headers, 'Content-Type': 'application/json'},
      body: jsonEncode({
        'review_id': reviewId,
        'answer': answer,
        if (ruleKind != null) 'rule_kind': ruleKind,
        if (matchKey != null) 'match_key': matchKey,
        if (matchKind != null) 'match_kind': matchKind,
        if (value != null) 'value': value,
      }),
    );
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultAuthException(res.statusCode, '/v1/learning/answer');
    }
    if (res.statusCode != 200) {
      throw Exception('POST /v1/learning/answer -> ${res.statusCode}: ${res.body}');
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return (answered: j['answered'] == true, ruleId: j['rule_id'] as int?);
  }

  /// Skip a question without creating a rule. Deliberately distinct from
  /// answering: a dismissal must not teach the vault anything.
  Future<void> dismissLearning(int reviewId) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/learning/dismiss'),
      headers: {..._headers, 'Content-Type': 'application/json'},
      body: jsonEncode({'review_id': reviewId}),
    );
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultAuthException(res.statusCode, '/v1/learning/dismiss');
    }
    if (res.statusCode != 200) {
      throw Exception('POST /v1/learning/dismiss -> ${res.statusCode}');
    }
  }

  Future<void> toggleLearning(bool enabled) async {
    await _client.post(
      Uri.parse('$baseUrl/v1/learning/toggle'),
      headers: {..._headers, 'content-type': 'application/json'},
      body: jsonEncode({'enabled': enabled}),
    );
  }

  /// Setup page: AI provider config, vault paths, active jurisdiction.
  Future<Map<String, dynamic>> settings() =>
      _get('/v1/settings', (j) => j);

  /// NOTE: the parameter is `aiBaseUrl`, not `baseUrl` — the latter would
  /// shadow the client's own field and build a nonsense URL.
  ///
  /// Save settings. Applies immediately — the daemon reconfigures its AI
  /// provider in place, so a saved key works on the next job without a restart.
  ///
  /// Pass an empty string to CLEAR a field. This used to drop empty values
  /// (`isNotEmpty`), which meant a key could be set but never removed — the
  /// same bug existed on the daemon side.
  Future<Map<String, dynamic>> saveSettings({
    String? aiBaseUrl,
    String? model,
    String? apiKey,
    String? jurisdiction,
    String? gmailLocalPart,
  }) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/settings'),
      headers: {..._headers, 'content-type': 'application/json'},
      body: jsonEncode({
        if (aiBaseUrl != null) 'base_url': aiBaseUrl,
        if (model != null) 'model': model,
        if (apiKey != null) 'api_key': apiKey,
        if (jurisdiction != null) 'jurisdiction': jurisdiction,
        if (gmailLocalPart != null) 'gmail_local_part': gmailLocalPart,
      }),
    );
    if (res.statusCode != 200) {
      throw Exception('save settings failed: ${res.statusCode} ${res.body}');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Clear the stored API key.
  Future<Map<String, dynamic>> clearApiKey() => saveSettings(apiKey: '');

  /// ── search + claims (work order 03 §P1/§P2) ───────────────────────────────

  /// Lexical search over filename, markdown and flattened extraction fields.
  Future<List<SearchHit>> search(String query, {int limit = 25}) {
    final q = Uri.encodeQueryComponent(query);
    return _get(
      '/v1/search?q=$q&limit=$limit',
      (j) => ((j['results'] ?? const []) as List)
          .map((e) => SearchHit.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  /// Per-field provenance for the evidence card: who claimed what, and how.
  Future<ClaimSet> claims(String subjectType, String subjectId) => _get(
        '/v1/$subjectType/$subjectId/claims',
        ClaimSet.fromJson,
      );

  /// Write a user claim and re-resolve. [subjectType] is 'documents',
  /// 'transactions' or 'entities'.
  ///
  /// A 409 is a REFUSAL, not a transport failure: the field is out of scope
  /// for this subject, or a confirmed claim outranks the write. It carries a
  /// machine-readable code the UI shows verbatim rather than a generic error.
  Future<ClaimWriteResult> writeClaim({
    required String subjectType,
    required String subjectId,
    required String field,
    required Object? value,
  }) async {
    final path = '/v1/$subjectType/$subjectId/claims';
    final res = await _client
        .patch(
          Uri.parse('$baseUrl$path'),
          headers: {..._headers, 'content-type': 'application/json'},
          body: jsonEncode({'field': field, 'value': value}),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw VaultAuthException(res.statusCode, path);
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode == 409) {
      throw ClaimRefusedException(
        j['error'] as String? ?? 'refused',
        j['message'] as String? ?? 'the vault refused this edit',
      );
    }
    if (res.statusCode != 200) {
      throw Exception('PATCH $path -> ${res.statusCode}');
    }
    return ClaimWriteResult.fromJson(j);
  }

  /// Append-only edit history for one subject.
  Future<List<AuditEntry>> audit(String subjectId, {int limit = 50}) => _get(
        '/v1/audit?subject_id=${Uri.encodeQueryComponent(subjectId)}&limit=$limit',
        (j) => ((j['audit'] ?? const []) as List)
            .map((e) => AuditEntry.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// ── settings, reset, people editing ───────────────────────────────────────

  /// Wipe the vault. [scope] is 'ledger' (documents/transactions/learnings,
  /// keeps credentials) or 'factory' (also clears the API key and Gmail auth).
  ///
  /// Neither scope deletes the user's documents from disk.
  Future<ResetResult> resetVault({required String scope}) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/reset'),
      headers: {..._headers, 'content-type': 'application/json'},
      body: jsonEncode({'scope': scope, 'confirm': 'RESET'}),
    );
    if (res.statusCode != 200) {
      throw Exception('reset failed: ${res.statusCode} ${res.body}');
    }
    return ResetResult.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// Edit one person. Any omitted field is left unchanged.
  ///
  /// Throws [PersonConflict] when the new name already belongs to somebody
  /// else — that is a merge, not a rename, and the caller must decide.
  Future<Map<String, dynamic>> editPerson(
    String id, {
    String? displayName,
    String? relationship,
    bool? isOwner,
  }) async {
    final body = <String, dynamic>{};
    if (displayName != null) body['display_name'] = displayName;
    if (relationship != null) body['relationship'] = relationship;
    if (isOwner != null) body['is_owner'] = isOwner;

    final res = await _client.patch(
      Uri.parse('$baseUrl/v1/people/$id'),
      headers: {..._headers, 'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    if (res.statusCode == 409) {
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      throw PersonConflict(
        (j['message'] as String?) ?? 'That name is already taken.',
        existingId: j['existing_id'] as String?,
      );
    }
    if (res.statusCode != 200) {
      throw Exception('edit person failed: ${res.statusCode} ${res.body}');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Delete a person. Without [force] the daemon refuses while documents still
  /// name them, rather than silently orphaning evidence.
  Future<Map<String, dynamic>> deletePerson(String id, {bool force = false}) async {
    final res = await _client.delete(
      Uri.parse('$baseUrl/v1/people/$id${force ? '?force=1' : ''}'),
      headers: _headers,
    );
    if (res.statusCode == 409) {
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      throw PersonInUse(
        (j['message'] as String?) ?? 'That person is named on documents.',
        documents: (j['documents'] as num?)?.toInt() ?? 0,
      );
    }
    if (res.statusCode != 200) {
      throw Exception('delete person failed: ${res.statusCode} ${res.body}');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Statement import summary + per-line drill-down (work order 04 §A.6).
  /// Throws [NotAStatement] for any other document type, so callers can
  /// simply omit the card rather than parse an error string.
  Future<StatementSummary> statementFor(String documentId) async {
    final res = await _client.get(
      Uri.parse('$baseUrl/v1/documents/$documentId/statement'),
      headers: _headers,
    );
    if (res.statusCode == 400) {
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      throw NotAStatement((j['message'] as String?) ?? 'Not a statement.');
    }
    if (res.statusCode == 404) {
      throw Exception('document not found: $documentId');
    }
    if (res.statusCode != 200) {
      throw Exception('statement fetch failed: ${res.statusCode} ${res.body}');
    }
    return StatementSummary.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// Push a file into P0 intake. Used by drag-and-drop.
  Future<Map<String, dynamic>> ingest(String path) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/intake'),
      headers: {..._headers, 'content-type': 'application/json'},
      body: jsonEncode({'path': path, 'source': 'desktop'}),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Server-Sent Events stream. Dart's HttpClient handles this cleanly without
  /// a dependency: we read the response body as a line stream and parse the
  /// `event:` / `data:` pairs ourselves.
  Stream<VaultEvent> events() async* {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$baseUrl/v1/events?token=$token'));
      req.headers.set('accept', 'text/event-stream');
      final res = await req.close();

      String? type;
      await for (final line
          in res.transform(utf8.decoder).transform(const LineSplitter())) {
        if (line.startsWith('event:')) {
          type = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          final raw = line.substring(5).trim();
          if (type != null && raw.isNotEmpty) {
            try {
              yield VaultEvent(type, jsonDecode(raw) as Map<String, dynamic>);
            } catch (_) {/* keepalive or malformed frame */}
          }
        } else if (line.isEmpty) {
          type = null;
        }
      }
    } finally {
      client.close(force: true);
    }
  }
}

/// ₹1,23,456 — whole rupees, no paise. The reference design shows figures at
/// a glance; two decimal places are noise at that size.
String rupeesWhole(int minor) {
  final full = rupees(minor);
  final dot = full.lastIndexOf('.');
  return dot > 0 ? full.substring(0, dot) : full;
}

/// ₹1,23,456.78 — Indian lakh/crore grouping, not thousands.
/// A naive NumberFormat gives ₹123,456.78, which is wrong for the jurisdiction.
String rupees(int minor) {
  final neg = minor < 0;
  final s = (minor.abs() ~/ 100).toString();
  final paise = (minor.abs() % 100).toString().padLeft(2, '0');

  String grouped;
  if (s.length <= 3) {
    grouped = s;
  } else {
    final last3 = s.substring(s.length - 3);
    var rest = s.substring(0, s.length - 3);
    final parts = <String>[];
    while (rest.length > 2) {
      parts.insert(0, rest.substring(rest.length - 2));
      rest = rest.substring(0, rest.length - 2);
    }
    if (rest.isNotEmpty) parts.insert(0, rest);
    grouped = '${parts.join(',')},$last3';
  }
  return '${neg ? '-' : ''}₹$grouped.$paise';
}
