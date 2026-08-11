library;

import 'state.dart';

abstract interface class SettingsGateway {
  Future<AppSettings> load();
  Future<AppSettings> save(AppSettings settings);
}
