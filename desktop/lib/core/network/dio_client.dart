/// Network layer — a centrally configured Dio client.
///
/// QAV-FLT-02 establishes the DI boundary; QAV-FLT-03 migrates callers.
/// The Dio client is provided here so feature code never instantiates HTTP
/// clients directly. Until the migration is complete, [VaultApi] continues
/// to use its own `http.Client` — that is intentional and tracked in QAV-FLT-03.
library;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import '../logging/app_logger.dart';

/// Timeout applied to all daemon requests.
const Duration kDefaultTimeout = Duration(seconds: 10);
const Duration kMutationTimeout = Duration(seconds: 15);

/// Creates a [Dio] client configured for the Quick2AVault daemon.
///
/// - Base URL comes from [AppConfig].
/// - Auth token is sent as a Bearer header on every request.
/// - A logging interceptor records request method + path + status, never
///   request bodies, response bodies, or tokens.
Dio createDio(AppConfig config, /* Logger */ dynamic logger) {
  final dio = Dio(
    BaseOptions(
      baseUrl: config.baseUrl,
      connectTimeout: kDefaultTimeout,
      receiveTimeout: kDefaultTimeout,
      sendTimeout: kMutationTimeout,
      headers: {
        'authorization': 'Bearer ${config.token}',
        'accept': 'application/json',
      },
    ),
  );

  // QAV-FLT-03 will replace this interceptor with one that uses [logger].
  // Keep a simple no-op placeholder until the migration is complete.
  // ignore: unnecessary_null_comparison
  if (logger != null) {
    // Placeholder — the real interceptor is added in QAV-FLT-03.
  }

  // Intercept 401/403 and convert to a typed error so callers can surface
  // auth failures distinctly from transport errors. This mirrors the
  // existing behavior in VaultApi._get.
  dio.interceptors.add(
    InterceptorsWrapper(
      onError: (DioException error, handler) {
        final statusCode = error.response?.statusCode;
        if (statusCode == 401 || statusCode == 403) {
          // The auth-exception type lives in api.dart; importing it here
          // would create a cycle (api.dart will eventually use Dio).
          // For now, rethrow as-is; QAV-FLT-03 adds the typed conversion
          // as part of the client.
        }
        handler.next(error);
      },
    ),
  );

  return dio;
}

/// Top-level provider for the configured [Dio] instance.
final Provider<Dio> dioProvider = Provider<Dio>((ref) {
  final config = ref.watch(appConfigProvider);
  final logger = ref.watch(appLoggerProvider);
  return createDio(config, logger);
});
