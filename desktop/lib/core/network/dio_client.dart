/// Network layer — a centrally configured Dio client.
///
/// QAV-FLT-02 establishes the DI boundary; QAV-FLT-03 migrates callers.
/// The Dio client is provided here so feature code never instantiates HTTP
/// clients directly.
library;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../config/app_config.dart';
import '../logging/app_logger.dart';

/// Timeout applied to all daemon read requests.
const Duration kDefaultTimeout = Duration(seconds: 10);

/// Timeout applied to mutations (POST/PUT/PATCH/DELETE).
const Duration kMutationTimeout = Duration(seconds: 15);

/// Creates a [Dio] client configured for the Quick2AVault daemon.
///
/// - Base URL comes from [AppConfig].
/// - Auth token is sent as a Bearer header on every request.
/// - A logging interceptor records method + path + status, never bodies,
///   tokens, or document contents.
Dio createDio(AppConfig config, Logger logger) {
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

  // Privacy-safe interceptor: logs method, path, status, and elapsed time.
  // NEVER logs request bodies, response bodies, or the auth header.
  dio.interceptors.add(
    LogInterceptor(
      requestBody: false,
      responseBody: false,
      requestHeader: false,
      responseHeader: false,
      error: true,
      logPrint: (obj) => logger.d(obj.toString()),
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
