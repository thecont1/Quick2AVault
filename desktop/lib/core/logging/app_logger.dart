/// Application logger.
///
/// Wraps the `logger` package in a Riverpod provider so tests can substitute
/// a no-op or capturing logger. The logger is the ONLY sink for diagnostics
/// — no raw `print` or `debugPrint` calls remain in production code.
library;

import 'package:flutter/foundation.dart';
import 'package:logger/logger.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// A [Logger] configured for the build mode.
///
/// - Debug: verbose (level [Level.debug]).
/// - Release: quiet (level [Level.warning]).
Logger createLogger() {
  final level = kDebugMode ? Level.debug : Level.warning;
  return Logger(
    level: level,
    printer: _PrivacySafePrinter(),
    filter: _ReleaseFilter(),
  );
}

/// Printer that redacts sensitive fields from any structured data it touches.
///
/// Keys matching 'token', 'authorization', 'cookie', 'password', 'api_key',
/// 'secret' are replaced with '«redacted»'.
class _PrivacySafePrinter extends LogPrinter {
  static const _sensitiveKeys = {
    'token',
    'authorization',
    'cookie',
    'password',
    'api_key',
    'apikey',
    'secret',
  };

  static Map _redact(Map input) {
    final out = <String, dynamic>{};
    for (final entry in input.entries) {
      final key = entry.key.toString().toLowerCase();
      if (_sensitiveKeys.any(key.contains)) {
        out[entry.key] = '«redacted»';
      } else {
        out[entry.key] = entry.value;
      }
    }
    return out;
  }

  @override
  List<String> log(LogEvent event) {
    final buffer = StringBuffer();
    buffer.write('${event.time} ');
    buffer.write(event.level.toString().padRight(7));
    buffer.write(' ');
    final msg = event.message;
    if (msg is Map) {
      buffer.write(_redact(msg));
    } else {
      buffer.write(msg);
    }
    return [buffer.toString()];
  }
}

/// Filter that suppresses verbose output in release builds.
class _ReleaseFilter extends LogFilter {
  @override
  bool shouldLog(LogEvent event) {
    if (kReleaseMode) return event.level.value >= Level.warning.value;
    return event.level.value >= Level.debug.value;
  }
}

/// Top-level provider for the application [Logger].
final Provider<Logger> appLoggerProvider =
    Provider<Logger>((ref) => createLogger());
