/// Core API client — the Flutter app is a CLIENT of the daemon, exactly like
/// the web UI and the MCP server. It owns no database and no business logic.
///
/// This is the whole point of the daemon architecture (plan §1): the UI is
/// replaceable, and swapping React for Flutter changes nothing below this file.
///
/// QAV-FLT-04: the model classes (Snapshot, Txn, VaultDoc, …) and money
/// formatting helpers now live in [models.dart] and [core/utils/money.dart].
/// This file re-exports both so existing `import 'api.dart'` call sites
/// continue to resolve every name without changing their imports.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:http/http.dart' as http;

import 'core/network/http_client_adapter.dart';
import 'models.dart';

export 'core/utils/money.dart';
export 'models.dart';

class VaultApi {
  final String baseUrl;
  final String token;
  final Dio _dio;

  /// Constructor — accepts an optional [Dio] for production/test injection,
  /// or an [http.Client] via the legacy [client] parameter for backward
  /// compatibility with existing test mocks (QAV-FLT-03 migration).
  VaultApi({
    required this.baseUrl,
    required this.token,
    Dio? dio,
    // Reuses the name `client` from the old http-based constructor so
    // existing tests that pass an http.MockClient still compile.
    http.Client? client,
  })  : _dio = dio ??
            (client != null
                ? _buildDio(baseUrl, token, client)
                : _buildDio(baseUrl, token, null));

  static Dio _buildDio(String baseUrl, String token, [http.Client? httpClient]) {
    final dio = Dio(
      BaseOptions(
        baseUrl: baseUrl,
        connectTimeout: kDefaultTimeout,
        receiveTimeout: kDefaultTimeout,
        sendTimeout: kMutationTimeout,
        headers: {
          'authorization': 'Bearer $token',
          'accept': 'application/json',
        },
      ),
    );
    if (httpClient != null) {
      dio.httpClientAdapter = HttpClienDioAdapter(httpClient);
    }
    return dio;
  }

  /// Timeout applied to all read requests.
  static const Duration kDefaultTimeout = Duration(seconds: 10);

  /// Timeout applied to mutations (POST/PUT/PATCH/DELETE).
  static const Duration kMutationTimeout = Duration(seconds: 15);

  /// Headers for loading a document image via Image.network.
  ///
  /// Exposed because the file route requires Bearer auth — query-string tokens
  /// are refused everywhere except /v1/events (they leak into logs, history and
  /// Referer headers). Image.network takes explicit headers, so the preview can
  /// authenticate without a URL token.
  Map<String, String> get imageHeaders => {'authorization': 'Bearer $token'};

  /// Auth headers for Dio requests (the Bearer token is in BaseOptions, but
  /// some endpoints need it explicitly).
  Map<String, String> get _authHeaders => {'authorization': 'Bearer $token'};

  /// Auth + JSON content-type headers for POST/PUT/PATCH with a body.
  Map<String, String> get _jsonHeaders => {
        'authorization': 'Bearer $token',
        'content-type': 'application/json',
      };

  // ─── Internal helpers ────────────────────────────────────────────────

  /// Generic typed GET: fetches [path], maps the JSON response via [parse],
  /// and maps HTTP errors to domain exceptions (auth, timeout, malformed).
  Future<T> _get<T>(String path, T Function(Map<String, dynamic>) parse,
      {CancelToken? cancelToken}) async {
    try {
      final res = await _dio.get(
        path,
        options: Options(headers: _authHeaders),
        cancelToken: cancelToken,
      );
      if (res.statusCode != 200) {
        throw Exception('GET $path -> ${res.statusCode}');
      }
      return parse(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      if (sc != 200 && sc != null) throw Exception('GET $path -> $sc');
      throw Exception('GET $path -> ${e.message}');
    }
  }

  /// Generic POST returning a Map, with auth error mapping.
  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic>? body,
  ) async {
    try {
      final res = await _dio.post(
        path,
        data: body,
        options: Options(
          headers: body == null
              ? _authHeaders
              : {..._authHeaders, 'content-type': 'application/json'},
        ),
      );
      if (res.statusCode != 200) {
        throw Exception('POST $path -> ${res.statusCode} ${res.data}');
      }
      return Map<String, dynamic>.from(res.data as Map);
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      throw Exception('POST $path -> $sc ${e.response?.data}');
    }
  }

  // ─── Endpoints ───────────────────────────────────────────────────────

  /// The document list for the Review browser.
  Future<List<VaultDoc>> documents({int limit = 200}) => _get(
        '/v1/documents?limit=$limit',
        (j) => ((j['documents'] ?? const []) as List)
            .map((e) => VaultDoc.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// URL for a document's original bytes. Needs [imageHeaders] to fetch.
  Uri documentFileUrl(String id) =>
      Uri.parse('$baseUrl/v1/documents/$id/file');

  /// URL for a magnifiable PAGE IMAGE — the preview source.
  ///
  /// Prefer this over [documentFileUrl] for display: the daemon rasterises PDFs
  /// server-side and caches the result, so the client needs no PDF plugin and
  /// treats every previewable document identically.
  ///
  /// Width defaults to the daemon's own default (2400px) by omission, so the
  /// resolution decision lives in ONE place rather than being duplicated here.
  Uri documentPageUrl(String id, {int page = 1, int? width}) => Uri.parse(
        '$baseUrl/v1/documents/$id/page?n=$page${width == null ? '' : '&w=$width'}',
      );

  /// Page count and render capability for a document.
  ///
  /// Never throws for an unpageable document — a 409 means "no page image",
  /// which is a legitimate answer (an email with no attachment), not a failure.
  Future<PageInfo> pageInfo(String id) async {
    try {
      final res = await _dio.get(
        '/v1/documents/$id/pageinfo',
        options: Options(headers: _authHeaders),
      );
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw VaultAuthException(res.statusCode ?? 0, '/v1/documents/$id/pageinfo');
      }
      if (res.statusCode != 200) return PageInfo.none;
      return PageInfo.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) {
        throw VaultAuthException(sc ?? 0, '/v1/documents/$id/pageinfo');
      }
      return PageInfo.none;
    }
  }

  /// The extracted text, for the Document/Markdown toggle.
  ///
  /// Returns null rather than throwing when conversion has not run (409): an
  /// unconverted document is a normal state, not an error, and the caller shows
  /// "not converted yet" instead of an error banner.
  Future<String?> documentMarkdown(String id) async {
    try {
      final res = await _dio.get(
        '/v1/documents/$id/markdown',
        options: Options(headers: _authHeaders),
      );
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw VaultAuthException(res.statusCode ?? 0, '/v1/documents/$id/markdown');
      }
      if (res.statusCode == 409 || res.statusCode == 410) return null;
      if (res.statusCode != 200) {
        throw Exception('GET /v1/documents/$id/markdown -> ${res.statusCode}');
      }
      final j = Map<String, dynamic>.from(res.data as Map);
      return j['markdown'] as String?;
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) {
        throw VaultAuthException(sc ?? 0, '/v1/documents/$id/markdown');
      }
      if (sc == 409 || sc == 410) return null;
      throw Exception('GET /v1/documents/$id/markdown -> $sc');
    }
  }

  /// Work order 07 §C1: structured health status. Replaces the bare bool
  /// `health()` so the client can distinguish compatible, outdated,
  /// unreachable, and capability-unavailable states. A stale daemon must not
  /// masquerade as an empty vault.
  Future<HealthStatus> healthStatus() async {
    try {
      final res = await _dio
          .get('/v1/health', options: Options(headers: _authHeaders))
          .timeout(const Duration(seconds: 3));
      if (res.statusCode != 200) {
        return HealthStatus.unreachable(statusCode: res.statusCode);
      }
      final j = Map<String, dynamic>.from(res.data as Map);
      return HealthStatus.fromJson(j);
    } catch (e) {
      return HealthStatus.unreachable(error: e.toString());
    }
  }

  /// Backward-compatible bool health check. Prefer [healthStatus] for new code.
  Future<bool> health() async {
    final s = await healthStatus();
    return s.isReachable;
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
    return _get(
      '/v1/transactions$qs',
      (j) => ((j['transactions'] ?? const []) as List)
          .map((e) => Txn.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Future<EvidenceCard> evidenceCard(String txnId) =>
      _get('/v1/transactions/$txnId/evidence', EvidenceCard.fromJson);

  Future<List<Map<String, dynamic>>> intakeFeed() => _get(
        '/v1/intake-feed',
        (j) => ((j['events'] ?? const []) as List).cast<Map<String, dynamic>>(),
      );

  /// Work order 06 §8 — recent intake with full disposition detail.
  Future<List<IntakeEvent>> intakeRecent({int limit = 50}) => _get(
        '/v1/intake/recent?limit=$limit',
        (j) => ((j['events'] ?? const []) as List)
            .map((e) => IntakeEvent.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// Work order 06 §9 — irrelevant items only, for the Irrelevant view.
  Future<List<IntakeEvent>> irrelevantItems({int limit = 200}) => _get(
        '/v1/irrelevant?limit=$limit',
        (j) => ((j['events'] ?? const []) as List)
            .map((e) => IntakeEvent.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// Work order 07 §B2 — aggregated user-facing intake status. Each row is
  /// one intake item with its current stage, terminal outcome, and actionable
  /// failure/retry information. Replaces raw Live Intake event churn.
  Future<List<IntakeEvent>> intakeStatus({int limit = 100}) => _get(
        '/v1/intake/status?limit=$limit',
        (j) => ((j['events'] ?? const []) as List)
            .map((e) => IntakeEvent.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// Work order 06 §8 — restore an irrelevant intake (re-triage and promote).
  Future<Map<String, dynamic>> restoreIntake(int id) =>
      _post('/v1/intake/$id/restore', null);

  /// Work order 06 §8 — reclassify an intake (force re-triage).
  Future<Map<String, dynamic>> reclassifyIntake(int id) =>
      _post('/v1/intake/$id/reclassify', null);

  /// Work order 07 §G — submit a password for an encrypted document.
  /// The intake must be in 'password_needed' state. The daemon stores the
  /// password on the document and re-enqueues the convert job.
  Future<Map<String, dynamic>> submitIntakePassword(
    int id,
    String password,
  ) =>
      _post(
        '/v1/intake/$id/password',
        {'password': password},
      );

  Future<List<Map<String, dynamic>>> entities({String? kind}) => _get(
        '/v1/entities${kind == null ? '' : '?kind=${Uri.encodeQueryComponent(kind)}'}',
        (j) => ((j['entities'] ?? const []) as List).cast<Map<String, dynamic>>(),
      );

  Future<List<Map<String, dynamic>>> reviews() =>
      _get(
        '/v1/reviews',
        (j) => ((j['reviews'] ?? const []) as List).cast<Map<String, dynamic>>(),
      );

  /// People the vault knows about, with the owner first.
  ///
  /// Work order 07 §E: the owner is derived from the daemon's canonical
  /// `owner` field in the response, not from a client-side filter. This
  /// prevents the contradictory state where the UI shows "No owner set"
  /// while a row has an OWNER badge, or multiple OWNER badges appear.
  Future<({List<Person> people, Person? owner})> people() async {
    final j = await _get('/v1/people', (x) => x);
    final list = ((j['people'] ?? const []) as List)
        .map((e) => Person.fromJson(e as Map<String, dynamic>))
        .toList();
    // Use the daemon-provided owner field as the single source of truth.
    // If the daemon says there is an owner, find that person in the list.
    // If the daemon-provided field is missing (older daemon), fall back to
    // the client-side filter but take only the FIRST to avoid multiple badges.
    final ownerJson = j['owner'] as Map<String, dynamic>?;
    Person? owner;
    if (ownerJson != null) {
      final ownerId = ownerJson['id'] as String?;
      owner = ownerId != null
          ? list.where((p) => p.id == ownerId).firstOrNull
          : null;
    } else {
      owner = list.where((p) => p.isOwner).firstOrNull;
    }
    // Work order 07 §E: if the daemon reports an owner, ensure only that
    // person is marked as owner in the list. This prevents multiple OWNER
    // badges when the database has stale is_owner=1 on multiple rows.
    // The UI uses the `owner` field from this method for the banner, and
    // the per-row badge logic checks `p.id == owner.id` instead of
    // `p.isOwner` to ensure a single source of truth.
    return (people: list, owner: owner);
  }

  /// One person in full: aliases with provenance, documents, transactions,
  /// open identity questions (work order 05 §B.6 drill-down).
  Future<PersonDetail> personDetail(String id) async {
    try {
      final res = await _dio.get(
        '/v1/people/$id',
        options: Options(headers: _authHeaders),
      );
      if (res.statusCode == 404) throw Exception('no such person');
      if (res.statusCode != 200) {
        throw Exception('person fetch failed: ${res.statusCode} ${res.data}');
      }
      return PersonDetail.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 404) throw Exception('no such person');
      throw Exception('person fetch failed: $sc ${e.response?.data}');
    }
  }

  /// Add an alias to a person. The daemon classifies the type from the
  /// string, so an email can never be stored as a name variant. Throws
  /// [PersonConflict] when the value is already bound to another person.
  Future<void> addPersonAlias(
    String personId,
    String alias, {
    String? aliasType,
  }) async {
    final body = <String, dynamic>{'alias': alias};
    if (aliasType != null) body['alias_type'] = aliasType;
    try {
      await _dio.post(
        '/v1/people/$personId/aliases',
        data: body,
        options: Options(headers: _jsonHeaders),
      );
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 409) {
        final j = e.response?.data as Map<String, dynamic>? ?? {};
        throw PersonConflict(
          (j['message'] as String?) ?? 'Already on file for another person.',
          existingId: j['bound_to'] as String?,
        );
      }
      throw Exception('add alias failed: $sc ${e.response?.data}');
    }
  }

  /// Reject an alias. The row is kept (status=rejected) so the same string
  /// is never re-proposed — rejection is durable, not deletion.
  Future<void> rejectPersonAlias(String personId, int aliasId) async {
    try {
      await _dio.delete(
        '/v1/people/$personId/aliases/$aliasId',
        options: Options(headers: _authHeaders),
      );
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc != 200) {
        throw Exception('reject alias failed: $sc ${e.response?.data}');
      }
    }
  }

  /// Declare a person, or update an existing one.
  Future<Map<String, dynamic>> savePerson({
    required String displayName,
    String? relationship,
    bool isMember = false,
    bool isOwner = false,
  }) =>
      _post(
        '/v1/people',
        {
          'display_name': displayName,
          if (relationship != null && relationship.isNotEmpty)
            'relationship': relationship,
          'is_member': isMember,
          'is_owner': isOwner,
        },
      );

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
    try {
      final res = await _dio.patch(
        '/v1/people/$id',
        data: body,
        options: Options(headers: _jsonHeaders),
      );
      final sc = res.statusCode;
      final j = Map<String, dynamic>.from(res.data as Map);
      if (sc == 409) {
        throw PersonConflict(
          (j['message'] as String?) ?? 'That name is already taken.',
          existingId: j['existing_id'] as String?,
        );
      }
      if (sc != 200) {
        throw Exception('edit person failed: $sc ${res.data}');
      }
      return j;
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      final j = e.response?.data as Map<String, dynamic>? ?? {};
      if (sc == 409) {
        throw PersonConflict(
          (j['message'] as String?) ?? 'That name is already taken.',
          existingId: j['existing_id'] as String?,
        );
      }
      throw Exception('edit person failed: $sc ${e.response?.data}');
    }
  }

  /// Delete a person. Without [force] the daemon refuses while documents still
  /// name them, rather than silently orphaning evidence.
  Future<Map<String, dynamic>> deletePerson(
    String id, {
    bool force = false,
  }) async {
    try {
      final res = await _dio.delete(
        '/v1/people/$id${force ? '?force=1' : ''}',
        options: Options(headers: _authHeaders),
      );
      final sc = res.statusCode;
      final j = Map<String, dynamic>.from(res.data as Map);
      if (sc == 409) {
        throw PersonInUse(
          (j['message'] as String?) ?? 'That person is named on documents.',
          documents: (j['documents'] as num?)?.toInt() ?? 0,
        );
      }
      if (sc != 200) {
        throw Exception('delete person failed: $sc ${res.data}');
      }
      return j;
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      final j = e.response?.data as Map<String, dynamic>? ?? {};
      if (sc == 409) {
        throw PersonInUse(
          (j['message'] as String?) ?? 'That person is named on documents.',
          documents: (j['documents'] as num?)?.toInt() ?? 0,
        );
      }
      throw Exception('delete person failed: $sc ${e.response?.data}');
    }
  }

  /// Statement import summary + per-line drill-down (work order 04 §A.6).
  /// Throws [NotAStatement] for any other document type, so callers can
  /// simply omit the card rather than parse an error string.
  Future<StatementSummary> statementFor(String documentId) async {
    try {
      final res = await _dio.get(
        '/v1/documents/$documentId/statement',
        options: Options(headers: _authHeaders),
      );
      final sc = res.statusCode;
      if (sc == 400) {
        final j = res.data as Map<String, dynamic>? ?? {};
        throw NotAStatement((j['message'] as String?) ?? 'Not a statement.');
      }
      if (sc == 404) throw Exception('document not found: $documentId');
      if (sc != 200) {
        throw Exception('statement fetch failed: $sc ${res.data}');
      }
      return StatementSummary.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 400) {
        final j = e.response?.data as Map<String, dynamic>? ?? {};
        throw NotAStatement((j['message'] as String?) ?? 'Not a statement.');
      }
      throw Exception('statement fetch failed: $sc ${e.response?.data}');
    }
  }

  /// Merge two people (never cross-kind — the daemon enforces it).
  Future<void> mergePeople({
    required String fromId,
    required String intoId,
  }) =>
      _post(
        '/v1/people/merge',
        {'from_id': fromId, 'into_id': intoId},
      ).then((_) {});

  /// WO11 A2 — merge two confirmed entities OF THE SAME KIND (people, orgs,
  /// or accounts). The daemon refuses cross-kind merges with 409.
  Future<void> mergeEntities({
    required String fromId,
    required String intoId,
  }) =>
      _post(
        '/v1/entities/merge',
        {'from_id': fromId, 'into_id': intoId},
      ).then((_) {});

  /// WO11 A3 — confirm a cross-kind identifier collision is two distinct
  /// entities. Recorded as a standing rule so the conflict stays dismissed.
  Future<void> keepEntitiesSeparate({
    required String identifier,
    required String entityId,
    required String otherId,
  }) =>
      _post(
        '/v1/entities/keep-separate',
        {'identifier': identifier, 'entity_ids': [entityId, otherId]},
      ).then((_) {});

  /// The Document Review evidence summary (work order 05 §A.3): raw
  /// extraction, winning claims with provenance, resolved parties, and the
  /// linked transactions — all with source amounts AND source currencies.
  Future<DocumentDetail> documentDetail(String id) async {
    try {
      final res = await _dio.get(
        '/v1/documents/$id/detail',
        options: Options(headers: _authHeaders),
      );
      if (res.statusCode == 404 || res.statusCode == 410) {
        Map<String, dynamic> j = const {};
        final decoded = res.data;
        if (decoded is Map) j = Map<String, dynamic>.from(decoded);
        if (j['error'] == 'document_not_available') {
          throw DocumentUnavailable(id, kind: 'removed');
        }
        if (j['error'] == 'document_deleted') {
          throw DocumentUnavailable(id, kind: 'deleted');
        }
        throw Exception('document not found: $id');
      }
      if (res.statusCode != 200) {
        throw Exception('document detail failed: ${res.statusCode} ${res.data}');
      }
      return DocumentDetail.fromJson(
        Map<String, dynamic>.from(res.data as Map),
      );
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 404 || sc == 410) {
        Map<String, dynamic> j = const {};
        final decoded = e.response?.data;
        if (decoded is Map) j = Map<String, dynamic>.from(decoded);
        if (j['error'] == 'document_not_available') {
          throw DocumentUnavailable(id, kind: 'removed');
        }
        if (j['error'] == 'document_deleted') {
          throw DocumentUnavailable(id, kind: 'deleted');
        }
        throw Exception('document not found: $id');
      }
      throw Exception('document detail failed: $sc ${e.response?.data}');
    }
  }

  /// Begin Gmail authorisation. Returns the consent URL — the daemon also
  /// opens it, but a URL the user can click is the reliable path.
  Future<({String? authUrl, String? error, String? detail})> gmailConnect() async {
    final res = await _post('/v1/gmail/connect', null);
    return (
      authUrl: res['auth_url'] as String?,
      error: res['error'] as String?,
      detail: res['detail'] as String?,
    );
  }

  Future<Map<String, dynamic>> gmailSync() =>
      _post('/v1/gmail/sync', null);

  Future<void> gmailDisconnect() =>
      _post('/v1/gmail/disconnect', null).then((_) {});

  /// Learning state: open questions and whether the engine is on.
  ///
  /// Kept returning a record for existing callers; use [learningState] for the
  /// typed shape the review screen needs.
  Future<({bool enabled, int budget, List<Map<String, dynamic>> questions})>
      learning() async {
    final j = await _get('/v1/learning', (x) => x);
    return (
      enabled: j['enabled'] == true,
      budget: (j['budget'] ?? 0) as int,
      questions:
          ((j['questions'] ?? const []) as List).cast<Map<String, dynamic>>(),
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
    final body = <String, dynamic>{
      'review_id': reviewId,
      'answer': answer,
    };
    if (ruleKind != null) body['rule_kind'] = ruleKind;
    if (matchKey != null) body['match_key'] = matchKey;
    if (matchKind != null) body['match_kind'] = matchKind;
    if (value != null) body['value'] = value;
    try {
      final res = await _dio.post(
        '/v1/learning/answer',
        data: body,
        options: Options(headers: _jsonHeaders),
      );
      final sc = res.statusCode;
      if (sc == 401 || sc == 403) {
        throw VaultAuthException(sc ?? 0, '/v1/learning/answer');
      }
      if (sc != 200) {
        throw Exception('POST /v1/learning/answer -> $sc: ${res.data}');
      }
      final j = Map<String, dynamic>.from(res.data as Map);
      return (answered: j['answered'] == true, ruleId: j['rule_id'] as int?);
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) {
        throw VaultAuthException(sc ?? 0, '/v1/learning/answer');
      }
      throw Exception('POST /v1/learning/answer -> $sc ${e.response?.data}');
    }
  }

  /// Skip a question without creating a rule. Deliberately distinct from
  /// answering: a dismissal must not teach the vault anything.
  Future<void> dismissLearning(int reviewId) async {
    final body = {'review_id': reviewId};
    try {
      final res = await _dio.post(
        '/v1/learning/dismiss',
        data: body,
        options: Options(headers: _jsonHeaders),
      );
      final sc = res.statusCode;
      if (sc == 401 || sc == 403) {
        throw VaultAuthException(sc ?? 0, '/v1/learning/dismiss');
      }
      if (sc != 200) {
        throw Exception('POST /v1/learning/dismiss -> $sc');
      }
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) {
        throw VaultAuthException(sc ?? 0, '/v1/learning/dismiss');
      }
      throw Exception('POST /v1/learning/dismiss -> $sc');
    }
  }

  Future<void> toggleLearning(bool enabled) => _post(
        '/v1/learning/toggle',
        {'enabled': enabled},
      ).then((_) {});

  /// Setup page: AI provider config, vault paths, active jurisdiction.
  Future<Map<String, dynamic>> settings() =>
      _get('/v1/settings', (j) => j);

  /// Save settings. Applies immediately — the daemon reconfigures its AI
  /// provider in place, so a saved key works on the next job without a restart.
  ///
  /// NOTE: the parameter is `aiBaseUrl`, not `baseUrl` — the latter would
  /// shadow the client's own field and build a nonsense URL.
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
    // Work order 07 §D2: secondary model fields.
    String? secondaryBaseUrl,
    String? secondaryModel,
    String? secondaryApiKey,
    String? routingMode,
  }) =>
      _post(
        '/v1/settings',
        {
          if (aiBaseUrl != null) 'base_url': aiBaseUrl,
          if (model != null) 'model': model,
          if (apiKey != null) 'api_key': apiKey,
          if (jurisdiction != null) 'jurisdiction': jurisdiction,
          if (gmailLocalPart != null) 'gmail_local_part': gmailLocalPart,
          if (secondaryBaseUrl != null) 'secondary_base_url': secondaryBaseUrl,
          if (secondaryModel != null) 'secondary_model': secondaryModel,
          if (secondaryApiKey != null) 'secondary_api_key': secondaryApiKey,
          if (routingMode != null) 'routing_mode': routingMode,
        },
      );

  /// Desktop preferences introduced by WO09/WO10. This uses the existing
  /// settings route, keeping the daemon as the source of truth.
  Future<Map<String, dynamic>> saveDesktopPreferences(
    Map<String, dynamic> values,
  ) {
    const supported = {
      'learning_enabled',
      'question_budget',
      'watcher_enabled',
      'scan_on_launch',
      'move_on_success',
      'drop_folder',
    };
    final payload = Map<String, dynamic>.fromEntries(
      values.entries.where((entry) => supported.contains(entry.key)),
    );
    return _post('/v1/settings', payload);
  }

  /// Clear the stored API key.
  Future<Map<String, dynamic>> clearApiKey() =>
      saveSettings(apiKey: '');

  /// Work order 07 §D4 — test a configured AI provider. Never sends vault
  /// content. Returns reachability, auth, model availability, structured
  /// output, vision, latency, and last-tested time.
  Future<Map<String, dynamic>> testProvider({String which = 'primary'}) =>
      _post('/v1/settings/provider-test', {'which': which});

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
  Future<ClaimSet> claims(String subjectType, String subjectId) =>
      _get('/v1/$subjectType/$subjectId/claims', ClaimSet.fromJson);

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
    try {
      final res = await _dio.patch(
        path,
        data: {'field': field, 'value': value},
        options: Options(headers: _jsonHeaders),
      );
      final sc = res.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      final j = Map<String, dynamic>.from(res.data as Map);
      if (sc == 409) {
        throw ClaimRefusedException(
          j['error'] as String? ?? 'refused',
          j['message'] as String? ?? 'the vault refused this edit',
        );
      }
      if (sc != 200) throw Exception('PATCH $path -> $sc');
      return ClaimWriteResult.fromJson(j);
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      final j = e.response?.data as Map<String, dynamic>? ?? {};
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      if (sc == 409) {
        throw ClaimRefusedException(
          j['error'] as String? ?? 'refused',
          j['message'] as String? ?? 'the vault refused this edit',
        );
      }
      throw Exception('PATCH $path -> $sc');
    }
  }

  /// Append-only edit history for one subject.
  Future<List<AuditEntry>> audit(String subjectId, {int limit = 50}) => _get(
        '/v1/audit?subject_id=${Uri.encodeQueryComponent(subjectId)}&limit=$limit',
        (j) => ((j['audit'] ?? const []) as List)
            .map((e) => AuditEntry.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// ── WO11/WO12 document parties + lifecycle ────────────────────────────

  /// Bind an entity to a document in a role (owner | counterparty | issuer |
  /// source_of_funds). Writes a document-scoped party row on the daemon; the
  /// old value is preserved in the audit trail. Throws [ClaimRefusedException]
  /// on a 409 (e.g. a cross-kind role violation the daemon guards).
  Future<void> setDocumentParty({
    required String documentId,
    required String role,
    required String entityId,
    double confidence = 1,
  }) async {
    final path = '/v1/documents/$documentId/parties';
    try {
      await _dio.put(
        path,
        data: {
          'role': role,
          'entity_id': entityId,
          'confidence': confidence,
          'edited_by': 'user',
        },
        options: Options(headers: _jsonHeaders),
      );
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      final j = e.response?.data as Map<String, dynamic>? ?? {};
      if (sc == 409) {
        throw ClaimRefusedException(
          j['error'] as String? ?? 'refused',
          j['message'] as String? ?? 'the vault refused this party edit',
        );
      }
      throw Exception('PUT $path -> $sc');
    }
  }

  /// Re-run analysis on a document (Glaze footer "Reprocess"). Idempotent on the
  /// ledger: re-analysis upserts the same transaction rather than creating a
  /// second economic event. Reactivates a soft-removed document.
  Future<void> reprocessDocument(String id) async {
    final path = '/v1/documents/$id/reprocess';
    try {
      await _dio.post(
        path,
        options: Options(headers: _authHeaders),
      );
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      throw Exception('POST $path -> $sc');
    }
  }

  /// Soft-remove a document from the active vault (Glaze footer "Remove from
  /// active"). The original file and every extracted claim are preserved; the
  /// document is hidden from Review. Reversible via [reprocessDocument].
  Future<void> removeFromActive(String id) async {
    final path = '/v1/documents/$id/remove-from-active';
    try {
      await _dio.post(path, options: Options(headers: _authHeaders));
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      throw Exception('POST $path -> $sc');
    }
  }

  /// WO12 phase 2: unlink a document from a transaction. Removes the
  /// evidence row from transaction_documents so the document is no longer
  /// proof for this transaction. The document itself is preserved — only
  /// the link is removed. Reversible by re-linking via the matcher.
  Future<bool> unlinkEvidence(String transactionId, String documentId) async {
    const path = '/v1/unlink';
    try {
      final res = await _dio.post(
        path,
        data: {
          'transaction_id': transactionId,
          'document_id': documentId,
        },
        options: Options(headers: _jsonHeaders),
      );
      final body = Map<String, dynamic>.from(res.data as Map);
      return body['unlinked'] == true;
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      throw Exception('POST $path -> $sc');
    }
  }

  /// Permanently delete a document (Glaze footer "Delete permanently"). Unlinks
  /// the raw + markdown bytes from disk and tombstones the row so the sha256
  /// dedupe guard still rejects a re-drop. Not reversible.
  Future<void> deleteDocument(String id) async {
    final path = '/v1/documents/$id';
    try {
      await _dio.delete(path, options: Options(headers: _authHeaders));
    } on DioException catch (e) {
      final sc = e.response?.statusCode;
      if (sc == 401 || sc == 403) throw VaultAuthException(sc ?? 0, path);
      throw Exception('DELETE $path -> $sc');
    }
  }

  /// Wipe the vault. [scope] is 'ledger' (documents/transactions/learnings,
  /// keeps credentials) or 'factory' (also clears the API key and Gmail auth).
  ///
  /// Neither scope deletes the user's documents from disk.
  Future<ResetResult> resetVault({required String scope}) async {
    final j = await _post(
      '/v1/reset',
      {'scope': scope, 'confirm': 'RESET'},
    );
    return ResetResult.fromJson(j);
  }

  /// Push a file into P0 intake. Used by drag-and-drop.
  Future<Map<String, dynamic>> ingest(String path) =>
      _post('/v1/intake', {'path': path, 'source': 'desktop'});

  /// Server-Sent Events stream.
  ///
  /// QAV-FLT-03: the HTTP transport is now Dio, but SSE requires a streaming
  /// response that Dio cannot deliver without buffering (it would hang on the
  /// never-ending event stream). So we keep a bare HttpClient for THIS ONE
  /// endpoint, configured with the same base URL and token. QAV-FLT-06 adds
  /// lifecycle-safe reconnection via a proper SSE package.
  Stream<VaultEvent> events() async* {
    final client = HttpClient();
    try {
      final req = await client.getUrl(
        Uri.parse('$baseUrl/v1/events?token=$token'),
      );
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
            } catch (_) {
              /* keepalive or malformed frame */
            }
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
