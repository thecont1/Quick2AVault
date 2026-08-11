/// QAV-FLT-05: VaultApi provider — the single Riverpod-managed instance of
/// the daemon client.
///
/// Widgets and notifiers read the API through this provider rather than
/// constructing their own. Tests override it with a mock or an
/// `http.MockClient`-backed instance.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api.dart';
import '../config/app_config.dart';
import '../network/dio_client.dart';

/// The application's [VaultApi]. Built once from [appConfigProvider] and
/// [dioProvider]; overridden in tests.
final Provider<VaultApi> vaultApiProvider = Provider<VaultApi>((ref) {
  final config = ref.watch(appConfigProvider);
  final dio = ref.watch(dioProvider);
  return VaultApi(baseUrl: config.baseUrl, token: config.token, dio: dio);
});
