library;

import 'state.dart';

abstract interface class IntakeGateway {
  Future<List<IntakeItem>> status();
  Future<void> reprocess(String id);
  Future<void> unlock(String id, String password);
}
