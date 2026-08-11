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

class EntitySummary {
  final String id;
  final String name;
  final EntityKind kind;
  final bool owner;
  final bool confirmed;
  final String? last4;
  final int documents;

  const EntitySummary({
    required this.id,
    required this.name,
    required this.kind,
    this.owner = false,
    this.confirmed = true,
    this.last4,
    this.documents = 0,
  });

  factory EntitySummary.fromJson(Map<String, dynamic> json) => EntitySummary(
    id: (json['id'] ?? '').toString(),
    name: (json['display_name'] ?? json['name'] ?? 'Unidentified').toString(),
    kind: EntityKindParsing.fromApi(json['kind']?.toString()),
    owner: json['is_owner'] == true || json['is_owner'] == 1,
    confirmed: (json['status'] ?? 'confirmed') == 'confirmed',
    last4: ((json['account_ref'] as Map?)?['last4'] ?? json['last4'])
        ?.toString(),
    documents: (json['document_count'] as num?)?.toInt() ?? 0,
  );
}
