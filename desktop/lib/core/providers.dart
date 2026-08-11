/// Core providers barrel — re-exports all application-infrastructure
/// providers so feature code imports a single, stable boundary.
///
/// New providers live in their respective /core subdirectories and are
/// exported here. This file is the DI surface; importing it gives a widget
/// or notifier everything it needs through [ProviderScope].
library;

export 'config/app_config.dart';
export 'logging/app_logger.dart';
export 'network/dio_client.dart';
export 'network/http_client_adapter.dart';
export 'services/platform_services.dart';
