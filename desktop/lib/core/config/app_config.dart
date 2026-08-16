import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Application configuration.
///
/// Read from `--dart-define` at build/run time so a single binary can point at
/// any daemon. No secrets are bundled — a missing token fails auth loudly
/// rather than shipping a guessable default.
///
/// 4477 is the daemon's default port (daemon/main.ts). A mismatch here produces
/// an app that connects to nothing and looks like an empty vault rather than a
/// configuration error.
class AppConfig {
  final String baseUrl;
  final String token;

  const AppConfig({
    required this.baseUrl,
    required this.token,
  });

  /// Read from `--dart-define` values at launch.
  ///
  /// Call this once, at app startup, before any network access.
  factory AppConfig.fromEnvironment() => AppConfig(
        baseUrl: const String.fromEnvironment(
          'Q2AV_URL',
          defaultValue: 'http://127.0.0.1:4477',
        ),
        // NOTE: no default token. A build without Q2AV_TOKEN gets an empty
        // string and fails auth loudly.
        token: const String.fromEnvironment('Q2AV_TOKEN'),
      );

  /// Override only what tests need.
  AppConfig copyWith({String? baseUrl, String? token}) => AppConfig(
        baseUrl: baseUrl ?? this.baseUrl,
        token: token ?? this.token,
      );
}

/// Top-level provider for [AppConfig]. Override this in tests to inject a
/// mock config without touching `String.fromEnvironment`.
final Provider<AppConfig> appConfigProvider =
    Provider<AppConfig>((ref) => AppConfig.fromEnvironment());
