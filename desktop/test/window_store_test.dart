// Window geometry must survive a restart, and must never restore a window to
// a display that is no longer attached.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/window_store.dart';

late Directory _tmp;

WindowStore _store([String name = 'window.json']) =>
    WindowStore(File('${_tmp.path}/$name'));

const _laptop = Rect.fromLTWH(0, 0, 1728, 1117);
const _external = Rect.fromLTWH(1728, 0, 2560, 1440);

void main() {
  setUp(() {
    _tmp = Directory.systemTemp.createTempSync('q2v_win');
  });
  tearDown(() => _tmp.deleteSync(recursive: true));

  test('a saved position survives a reload', () async {
    final a = _store();
    await a.save('popup', position: const Offset(300, 120), size: const Size(420, 620));

    final b = _store();
    await b.load();
    expect(b.position('popup', displays: [_laptop]), const Offset(300, 120));
    expect(b.size('popup'), const Size(420, 620));
  });

  test('popup and full window are remembered independently', () async {
    // Restoring one from the other would fling the panel across the screen:
    // the popup is anchored under the tray, the full window is centred.
    final s = _store();
    await s.save('popup', position: const Offset(1015, 39));
    await s.save('full', position: const Offset(324, 72), size: const Size(1360, 880));

    final t = _store();
    await t.load();
    expect(t.position('popup', displays: [_laptop]), const Offset(1015, 39));
    expect(t.position('full', displays: [_laptop]), const Offset(324, 72));
  });

  test('a position on a detached display is rejected', () async {
    // Saved while an external monitor was plugged in...
    final s = _store();
    await s.save('full', position: const Offset(2200, 400));

    final t = _store();
    await t.load();
    // ...and that monitor is now gone. Restoring here would put the window
    // somewhere unreachable, which looks exactly like the app not launching.
    expect(t.position('full', displays: [_laptop]), isNull);
    // Still valid while the monitor is attached.
    expect(t.position('full', displays: [_laptop, _external]),
        const Offset(2200, 400));
  });

  test('a window whose title bar is above the screen is rejected', () async {
    // The check is on the grabbable strip, not the origin: a window dragged
    // slightly off the left edge is still recoverable, one above the top is
    // not.
    final s = _store();
    await s.save('full', position: const Offset(400, -200));
    final t = _store();
    await t.load();
    expect(t.position('full', displays: [_laptop]), isNull);
  });

  test('a window slightly off the left edge is still accepted', () async {
    final s = _store();
    await s.save('full', position: const Offset(-30, 300));
    final t = _store();
    await t.load();
    expect(t.position('full', displays: [_laptop]), isNotNull,
        reason: 'the title bar is still grabbable, so this is recoverable');
  });

  test('a corrupt file falls back to defaults instead of crashing', () async {
    final f = File('${_tmp.path}/window.json');
    await f.writeAsString('{not json at all');
    final s = WindowStore(f);
    await s.load();
    expect(s.position('popup', displays: [_laptop]), isNull);
  });

  test('a missing file is not an error', () async {
    final s = WindowStore(File('${_tmp.path}/nope/window.json'));
    await s.load();
    expect(s.position('full', displays: [_laptop]), isNull);
  });

  test('an absurdly small saved size is ignored', () async {
    // Guards against a zero/garbage size making the window unusable.
    final f = File('${_tmp.path}/window.json');
    await f.writeAsString(jsonEncode({
      'full': {'x': 10, 'y': 10, 'w': 4, 'h': 4},
    }));
    final s = WindowStore(f);
    await s.load();
    expect(s.size('full'), isNull);
    expect(s.position('full', displays: [_laptop]), const Offset(10, 10));
  });
}
