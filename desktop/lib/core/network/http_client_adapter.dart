/// A Dio [HttpClientAdapter] that delegates to a [http.Client].
///
/// This adapter lets tests reuse their existing `http.MockClient` setup
/// when constructing a [VaultApi]. It translates Dio's
/// [RequestOptions] → [http.Request] → [http.Response] round-trip.
///
/// Production code never uses this — it goes straight to Dio's
/// [IOHttpClientAdapter]. This exists purely so QAV-FLT-03 can migrate
/// `VaultApi` to Dio without rewriting every test mock at the same time.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:http/http.dart' as http;

/// Wraps an [http.Client] as a Dio [HttpClientAdapter].
class HttpClienDioAdapter implements HttpClientAdapter {
  final http.Client client;

  HttpClienDioAdapter(this.client);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final uri = options.uri;
    final request = http.Request(options.method, uri);

    // Copy headers (Dio puts auth in options.headers; http expects them
    // on the request).
    options.headers.forEach((key, value) {
      if (value != null) {
        request.headers[key] = value.toString();
      }
    });

    // Attach body if present.
    if (requestStream != null) {
      final bytes = await requestStream.toList();
      final body = bytes.expand((b) => b).toList();
      request.bodyBytes = Uint8List.fromList(body);
    }

    final streamed = await client.send(request);
    final response = await http.Response.fromStream(streamed);

    final headers = _toLowerCase(response.headers);
    // Ensure Dio can auto-parse JSON responses. MockClient responses don't
    // always set content-type, which would leave res.data as a String
    // instead of a decoded Map.
    final ct = headers['content-type'];
    if (ct == null) {
      headers['content-type'] = ['application/json'];
    } else if (!ct.first.contains('application/json')) {
      // Try to parse as JSON to determine content-type.
      try {
        jsonDecode(response.body);
        headers['content-type'] = ['application/json'];
      } catch (_) {}
    }

    return ResponseBody(
      Stream.value(Uint8List.fromList(utf8.encode(response.body))),
      response.statusCode,
      headers: headers,
      statusMessage: response.reasonPhrase,
    );
  }

  static Map<String, List<String>> _toLowerCase(Map<String, String> headers) {
    final out = <String, List<String>>{};
    for (final entry in headers.entries) {
      out[entry.key.toLowerCase()] = [entry.value];
    }
    return out;
  }

  @override
  void close({bool force = false}) => client.close();
}
