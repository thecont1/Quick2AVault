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

  /// Persist AI provider settings. The daemon reloads them on restart.
  /// NOTE: the parameter is `aiBaseUrl`, not `baseUrl` — the latter would
  /// shadow the client's own field and build a nonsense URL.
  Future<Map<String, dynamic>> saveSettings({
    String? aiBaseUrl,
    String? model,
    String? apiKey,
    String? gmailLocalPart,
  }) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/v1/settings'),
      headers: {..._headers, 'content-type': 'application/json'},
      body: jsonEncode({
        if (aiBaseUrl != null && aiBaseUrl.isNotEmpty) 'base_url': aiBaseUrl,
        if (model != null && model.isNotEmpty) 'model': model,
        if (apiKey != null && apiKey.isNotEmpty) 'api_key': apiKey,
        if (gmailLocalPart != null && gmailLocalPart.isNotEmpty)
          'gmail_local_part': gmailLocalPart,
      }),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
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
