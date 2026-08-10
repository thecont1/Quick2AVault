library;

import 'state.dart';

abstract interface class EntityGateway {
  Future<List<EntitySummary>> list({EntityKind? kind});
  Future<void> merge({required String sourceId, required String targetId});
  Future<void> setOwner(String entityId);
}
