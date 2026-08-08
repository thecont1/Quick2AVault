import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';

/// Remembers where the user put each window.
///
/// Two independent geometries: the popup panel and the full window. They are
/// separate because the popup is anchored under the tray icon by default and
/// the full window is centred — restoring one from the other would fling the
/// panel across the screen.
///
/// Stored as JSON next to the vault rather than in NSUserDefaults so the state
/// travels with the app's own data and can be inspected or deleted by hand.
class WindowStore {
  final File _file;
  Map<String, dynamic> _cache = {};

  WindowStore(this._file);

  /// Default location: ~/.quick2avault/window.json — deliberately NOT inside
  /// the vault directory, which is user data and gets synced or backed up.
  /// Window position is machine-local preference, not vault content.
  factory WindowStore.defaultLocation() {
    final home = Platform.environment['HOME'] ?? '.';
    return WindowStore(File('$home/.quick2avault/window.json'));
  }

  Future<void> load() async {
    try {
      if (!await _file.exists()) return;
      final raw = await _file.readAsString();
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) _cache = decoded;
    } catch (_) {
      // A corrupt or unreadable file must never stop the app launching. The
      // consequence of losing it is one badly-placed window, so silently
      // falling back to defaults is the right trade.
      _cache = {};
    }
  }

  /// Saved position for [key] ('popup' or 'full'), or null if never saved or
  /// no longer on any attached display.
  Offset? position(String key, {required List<Rect> displays}) {
    final m = _cache[key];
    if (m is! Map) return null;
    final x = (m['x'] as num?)?.toDouble();
    final y = (m['y'] as num?)?.toDouble();
    if (x == null || y == null) return null;

    // A saved position is only valid if it still lands on a display. Restoring
    // a window to a monitor that has been unplugged puts it somewhere the user
    // cannot reach and looks exactly like the app failing to launch.
    //
    // The check is on the TITLE BAR STRIP rather than the window origin: a
    // window whose top-left is just off the left edge is still grabbable, but
    // one whose entire top edge is above the display is not.
    const grabHeight = 24.0;
    const minVisible = 80.0;
    final strip = Rect.fromLTWH(x, y, minVisible, grabHeight);
    final reachable = displays.any((d) => d.overlaps(strip));
    if (!reachable) return null;

    return Offset(x, y);
  }

  /// Saved size for [key], rejected if implausible.
  ///
  /// The floor is per-slot and deliberately strict for 'full': a full-window
  /// geometry at or below the popup's 420x620 is not a size the user could
  /// have chosen — it is a symptom of the wrong slot being written, which is
  /// exactly the bug that made the Document Viewer open as a 420px panel.
  /// Rejecting it falls back to kFullSize, which is always correct-ish, rather
  /// than faithfully restoring a corrupt value.
  Size? size(String key) {
    final m = _cache[key];
    if (m is! Map) return null;
    final w = (m['w'] as num?)?.toDouble();
    final h = (m['h'] as num?)?.toDouble();
    if (w == null || h == null) return null;
    final minW = key == 'full' ? 700.0 : 200.0;
    final minH = key == 'full' ? 500.0 : 200.0;
    if (w < minW || h < minH) return null;
    return Size(w, h);
  }

  Future<void> save(
    String key, {
    required Offset position,
    Size? size,
  }) async {
    _cache[key] = {
      'x': position.dx,
      'y': position.dy,
      if (size != null) 'w': size.width,
      if (size != null) 'h': size.height,
    };
    try {
      await _file.parent.create(recursive: true);
      await _file.writeAsString(jsonEncode(_cache));
    } catch (_) {
      // Best effort. Failing to persist geometry is not worth surfacing.
    }
  }
}
