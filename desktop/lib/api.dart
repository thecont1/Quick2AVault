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

class VaultApi {
  final String baseUrl;
  final String token;
  final http.Client _client;

  VaultApi({required this.baseUrl, required this.token, http.Client? client})
      : _client = client ?? http.Client();

  Map<String, String> get _headers => {'authorization': 'Bearer $token'};

  Future<T> _get<T>(String path, T Function(Map<String, dynamic>) parse) async {
    final res = await _client
        .get(Uri.parse('$baseUrl$path'), headers: _headers)
        .timeout(const Duration(seconds: 10));
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

  Future<List<Txn>> transactions() => _get('/v1/transactions', (j) =>
      ((j['transactions'] ?? const []) as List)
          .map((e) => Txn.fromJson(e as Map<String, dynamic>))
          .toList());

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
