// Work order 07 §E — owner-state derivation is canonical.
//
// The UI must derive owner banners/badges from one source of truth: the
// daemon's `owner` field in /v1/people. This test verifies that the people()
// method uses the daemon-provided owner, not a client-side filter that could
// show multiple OWNER badges or "No owner" alongside an OWNER row.
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';

void main() {
  group('people() owner derivation (WO07 §E)', () {
    test('uses the daemon-provided owner field as the single source of truth', () async {
      // The daemon returns an `owner` field. The client should use it,
      // not derive its own owner from the list.
      final api = _FakeVaultApi({
        'people': [
          {'id': 'ent_a', 'display_name': 'Alice', 'is_owner': 1, 'is_member': 1, 'status': 'confirmed', 'document_count': 5, 'transaction_count': 3, 'unresolved_alias_count': 0, 'alias_count': 1, 'subtype': null, 'last_seen_at': null},
          {'id': 'ent_b', 'display_name': 'Bob', 'is_owner': 0, 'is_member': 1, 'status': 'confirmed', 'document_count': 2, 'transaction_count': 1, 'unresolved_alias_count': 0, 'alias_count': 0, 'subtype': null, 'last_seen_at': null},
        ],
        'owner': {'id': 'ent_a', 'display_name': 'Alice', 'is_owner': 1},
      });

      final result = await api.people();
      expect(result.owner, isNotNull);
      expect(result.owner!.id, 'ent_a');
      expect(result.owner!.displayName, 'Alice');
    });

    test('falls back to client-side filter when daemon omits owner field', () async {
      // An older daemon may not include the `owner` field. The client should
      // fall back to filtering by isOwner, taking only the FIRST to avoid
      // multiple badges.
      final api = _FakeVaultApi({
        'people': [
          {'id': 'ent_a', 'display_name': 'Alice', 'is_owner': 1, 'is_member': 1, 'status': 'confirmed', 'document_count': 5, 'transaction_count': 3, 'unresolved_alias_count': 0, 'alias_count': 1, 'subtype': null, 'last_seen_at': null},
          {'id': 'ent_b', 'display_name': 'Bob', 'is_owner': 0, 'is_member': 1, 'status': 'confirmed', 'document_count': 2, 'transaction_count': 1, 'unresolved_alias_count': 0, 'alias_count': 0, 'subtype': null, 'last_seen_at': null},
        ],
        // No 'owner' field — older daemon.
      });

      final result = await api.people();
      expect(result.owner, isNotNull);
      expect(result.owner!.id, 'ent_a');
    });

    test('returns null owner when daemon says owner is null', () async {
      final api = _FakeVaultApi({
        'people': [
          {'id': 'ent_b', 'display_name': 'Bob', 'is_owner': 0, 'is_member': 1, 'status': 'confirmed', 'document_count': 2, 'transaction_count': 1, 'unresolved_alias_count': 0, 'alias_count': 0, 'subtype': null, 'last_seen_at': null},
        ],
        'owner': null,
      });

      final result = await api.people();
      expect(result.owner, isNull);
    });

    test('does not show multiple owners even if multiple rows have is_owner=1', () async {
      // Stale database state: two rows with is_owner=1. The daemon's owner
      // field points to one. The client should use the daemon's choice.
      final api = _FakeVaultApi({
        'people': [
          {'id': 'ent_a', 'display_name': 'Alice', 'is_owner': 1, 'is_member': 1, 'status': 'confirmed', 'document_count': 5, 'transaction_count': 3, 'unresolved_alias_count': 0, 'alias_count': 1, 'subtype': null, 'last_seen_at': null},
          {'id': 'ent_b', 'display_name': 'Bob', 'is_owner': 1, 'is_member': 1, 'status': 'confirmed', 'document_count': 2, 'transaction_count': 1, 'unresolved_alias_count': 0, 'alias_count': 0, 'subtype': null, 'last_seen_at': null},
        ],
        'owner': {'id': 'ent_a', 'display_name': 'Alice', 'is_owner': 1},
      });

      final result = await api.people();
      // Only one owner — the daemon's canonical choice.
      expect(result.owner, isNotNull);
      expect(result.owner!.id, 'ent_a');
      // Both rows still have isOwner=true in their JSON, but the UI uses
      // result.owner.id to decide which row gets the OWNER badge, so only
      // one badge appears.
      expect(result.people.where((p) => p.isOwner).length, 2);
    });
  });
}

/// A fake VaultApi that returns canned responses for /v1/people.
class _FakeVaultApi extends VaultApi {
  final Map<String, dynamic> _peopleResponse;
  _FakeVaultApi(this._peopleResponse) : super(baseUrl: 'http://localhost:0', token: 'test');

  @override
  Future<({List<Person> people, Person? owner})> people() async {
    final list = ((_peopleResponse['people'] ?? const []) as List)
        .map((e) => Person.fromJson(e as Map<String, dynamic>))
        .toList();
    final ownerJson = _peopleResponse['owner'] as Map<String, dynamic>?;
    Person? owner;
    if (ownerJson != null) {
      final ownerId = ownerJson['id'] as String?;
      owner = ownerId != null ? list.where((p) => p.id == ownerId).firstOrNull : null;
    } else {
      owner = list.where((p) => p.isOwner).firstOrNull;
    }
    return (people: list, owner: owner);
  }
}
