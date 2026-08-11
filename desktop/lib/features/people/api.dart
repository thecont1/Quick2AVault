library;

import 'state.dart';

abstract interface class EntityGateway {
  Future<List<EntitySummary>> list({EntityKind? kind});
  Future<void> merge({required String sourceId, required String targetId});

  /// WO11 A1: exclusive owner toggle. Setting `owner: true` on a person
  /// unsets the previous owner atomically on the daemon.
  Future<void> setOwner(String entityId, {required bool owner});

  /// WO11 A3: the user confirms a cross-kind collision is two distinct
  /// entities sharing an identifier — dismiss it for good.
  Future<void> keepSeparate({
    required String identifier,
    required String entityId,
    required String otherId,
  });
}
