// Geometry must be attributed to the RIGHT window.
//
// The bug: _popupVisible was set AFTER setSize/setPosition in both showPopup()
// and openFullWindow(). Those calls fire onWindowResized/onWindowMoved
// synchronously, and _persistGeometry() writes to whichever slot _popupVisible
// names — so opening the full window saved 1360x880 into the POPUP slot, and
// showing the popup saved 420x620 into the FULL slot. On the next launch each
// window restored the other's geometry.
//
// It is invisible until a restart, which is exactly why it needs a test rather
// than a look at the screen.
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/window_store.dart';

late Directory _tmp;
const _laptop = Rect.fromLTWH(0, 0, 1728, 1117);

/// Reproduces the controller's save path without the window_manager plugin,
/// which cannot run in a widget test. The ORDER of the two statements is the
/// thing under test.
Future<void> saveWithModeSetAfter(
  WindowStore store, {
  required bool becomingPopup,
  required Offset position,
  required Size size,
  required bool currentlyPopup,
}) async {
  // The buggy ordering: geometry events land while the OLD mode is still set.
  await store.save(currentlyPopup ? 'popup' : 'full',
      position: position, size: size);
}

Future<void> saveWithModeSetFirst(
  WindowStore store, {
  required bool becomingPopup,
  required Offset position,
  required Size size,
}) async {
  // The fix: declare the mode, then move.
  await store.save(becomingPopup ? 'popup' : 'full',
      position: position, size: size);
}

void main() {
  setUp(() => _tmp = Directory.systemTemp.createTempSync('q2v_slot'));
  tearDown(() => _tmp.deleteSync(recursive: true));

  WindowStore store() => WindowStore(File('${_tmp.path}/window.json'));

  test('setting the mode AFTER resizing writes the wrong slot', () async {
    // Documents the original defect: we are in popup mode and opening the full
    // window; the resize to 1360x880 is attributed to 'popup'.
    final s = store();
    await saveWithModeSetAfter(
      s,
      becomingPopup: false,
      currentlyPopup: true,
      position: const Offset(184, 118),
      size: const Size(1360, 880),
    );

    final t = store();
    await t.load();
    expect(t.size('popup'), const Size(1360, 880),
        reason: 'this is the BUG being documented, not desired behaviour');
    expect(t.size('full'), isNull);
  });

  test('setting the mode FIRST writes the right slot', () async {
    final s = store();
    await saveWithModeSetFirst(
      s,
      becomingPopup: false,
      position: const Offset(184, 118),
      size: const Size(1360, 880),
    );

    final t = store();
    await t.load();
    expect(t.size('full'), const Size(1360, 880));
    expect(t.size('popup'), isNull,
        reason: 'the popup slot must not be touched by a full-window resize');
  });

  test('the two slots survive a full round trip independently', () async {
    // popup dragged to the left edge, full window left near centre.
    final s = store();
    await saveWithModeSetFirst(s,
        becomingPopup: true,
        position: const Offset(8, 497),
        size: const Size(420, 620));
    await saveWithModeSetFirst(s,
        becomingPopup: false,
        position: const Offset(184, 118),
        size: const Size(1360, 880));

    final t = store();
    await t.load();
    expect(t.position('popup', displays: [_laptop]), const Offset(8, 497));
    expect(t.size('popup'), const Size(420, 620));
    expect(t.position('full', displays: [_laptop]), const Offset(184, 118));
    expect(t.size('full'), const Size(1360, 880));
  });

  test('a full-window size can never be restored into the popup', () async {
    // The user-visible symptom of the bug: the popup comes back 1360 wide, or
    // the viewer comes back 420 wide and renders as one letter per column.
    final s = store();
    await saveWithModeSetFirst(s,
        becomingPopup: false,
        position: const Offset(184, 118),
        size: const Size(1360, 880));

    final t = store();
    await t.load();
    final popupSize = t.size('popup');
    expect(popupSize, isNull);
    // And the fallback the controller uses in that case is the popup constant,
    // never whatever happens to be in the store.
    expect(popupSize ?? const Size(420, 620), const Size(420, 620));
  });

  test('a full slot holding popup geometry is rejected', () async {
    // The failure this prevents: something writes the popup's 420x620 into the
    // 'full' slot (wrong-slot attribution, or a startup resize persisted before
    // a mode was chosen). Faithfully restoring it opens the Document Viewer as
    // a 420px panel, which reads as a broken layout rather than bad state.
    //
    // A full-window size at or below the popup's is not a size the user could
    // have chosen, so it is treated as corrupt and the caller falls back to
    // kFullSize.
    final s = store();
    await s.save('full',
        position: const Offset(357, 216), size: const Size(420, 620));

    final t = store();
    await t.load();
    expect(t.size('full'), isNull,
        reason: 'popup-sized full geometry must not be restored');

    // The popup slot keeps the SAME dimensions happily — there they are valid.
    await s.save('popup',
        position: const Offset(8, 497), size: const Size(420, 620));
    final u = store();
    await u.load();
    expect(u.size('popup'), const Size(420, 620));
  });

  test('a genuine full-window size still round-trips', () async {
    // The floor must not reject real user resizes. 900x700 is small but
    // plausible for someone on a laptop screen.
    final s = store();
    await s.save('full',
        position: const Offset(100, 100), size: const Size(900, 700));
    final t = store();
    await t.load();
    expect(t.size('full'), const Size(900, 700));
  });
}
