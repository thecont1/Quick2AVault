library;

import 'state.dart';

abstract interface class DocumentGateway {
  Future<DetailDocument> detail(String id);
  Future<void> setField(String id, String field, Object value);
  Future<void> setParty(String id, String role, String entityId);
}
