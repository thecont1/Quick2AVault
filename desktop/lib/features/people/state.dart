import 'dart:convert';

enum EntityKind { person, organisation, account }

extension EntityKindParsing on EntityKind {
  static EntityKind fromApi(String? value) => switch (value) {
    'organisation' => EntityKind.organisation,
    'account' => EntityKind.account,
    _ => EntityKind.person,
  };
}

extension EntityKindLabel on EntityKind {
  String get label => switch (this) {
    EntityKind.person => 'person',
    EntityKind.organisation => 'organisation',
    EntityKind.account => 'account',
  };
}

/// WO11 A3 — a cross-kind identifier collision: this entity and a confirmed
/// entity of a DIFFERENT kind carry the same email/phone/handle. Rendered as
/// a Conflicts section with a keep-separate action; never a merge offer.
class EntityConflict {
  final String identifier;
  final String identifierType;
  final String otherId;
  final String otherName;
  final EntityKind otherKind;

  const EntityConflict({
    required this.identifier,
    required this.identifierType,
    required this.otherId,
    required this.otherName,
    required this.otherKind,
  });

  factory EntityConflict.fromJson(Map<String, dynamic> json) => EntityConflict(
    identifier: (json['identifier'] ?? '').toString(),
    identifierType: (json['identifier_type'] ?? 'email').toString(),
    otherId: (json['other_id'] ?? '').toString(),
    otherName: (json['other_name'] ?? 'Unknown').toString(),
    otherKind: EntityKindParsing.fromApi(json['other_kind']?.toString()),
  );
}

class EntitySummary {
  final String id;
  final String name;
  final EntityKind kind;
  final bool owner;
  final bool confirmed;
  final String? last4;
  final int documents;

  /// Primary email carried in identifiers_json, when present. Used to
  /// disambiguate same-name entities in the merge picker (WO11 A2).
  final String? email;

  /// Cross-kind identifier collisions involving this entity (WO11 A3).
  final List<EntityConflict> conflicts;

  const EntitySummary({
    required this.id,
    required this.name,
    required this.kind,
    this.owner = false,
    this.confirmed = true,
    this.last4,
    this.documents = 0,
    this.email,
    this.conflicts = const [],
  });

  factory EntitySummary.fromJson(Map<String, dynamic> json) {
    final identifiers = _parseIdentifiers(json['identifiers_json']);
    return EntitySummary(
      id: (json['id'] ?? '').toString(),
      name: (json['display_name'] ?? json['name'] ?? 'Unidentified').toString(),
      kind: EntityKindParsing.fromApi(json['kind']?.toString()),
      owner: json['is_owner'] == true || json['is_owner'] == 1,
      confirmed: (json['status'] ?? 'confirmed') == 'confirmed',
      last4:
          ((json['account_ref'] as Map?)?['last4'] ??
                  json['last4'] ??
                  _last4From(identifiers))
              ?.toString(),
      documents: (json['document_count'] as num?)?.toInt() ?? 0,
      email: identifiers['email']?.toString(),
      conflicts: ((json['conflicts'] ?? const []) as List)
          .whereType<Map>()
          .map((c) => EntityConflict.fromJson(c.cast<String, dynamic>()))
          .toList(),
    );
  }

  static Map<String, dynamic> _parseIdentifiers(Object? raw) {
    if (raw is Map) return raw.cast<String, dynamic>();
    if (raw is String && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map) return decoded.cast<String, dynamic>();
      } catch (_) {
        // Legacy malformed identifiers — treated as absent.
      }
    }
    return const {};
  }

  static String? _last4From(Map<String, dynamic> identifiers) {
    final refs = identifiers['accountRef'];
    if (refs is List && refs.isNotEmpty) {
      final first = refs.first;
      if (first is Map && first['last4'] != null) return first['last4'].toString();
    }
    return null;
  }
}
