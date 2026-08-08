/// Menubar controller — the Glaze "tray popup" model.
///
/// The app lives in the macOS menu bar. Clicking the icon toggles a small
/// frameless panel anchored under it; clicking away hides it. The full window
/// is opened from the panel or the tray menu.
///
/// Two packages do the work:
///   tray_manager   — status item, icon, context menu
///   window_manager — frameless/always-on-top/skip-taskbar, positioning
library;



import 'package:flutter/material.dart';
import 'package:screen_retriever/screen_retriever.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'window_store.dart';

/// Popup geometry — deliberately narrow, like a menubar utility rather than
/// a document window.
const kPopupSize = Size(420, 620);
const kFullSize = Size(1360, 880);

class MenubarController with TrayListener, WindowListener {
  MenubarController({
    required this.onOpenFull,
    required this.onQuit,
    this.onShowPopup,
    WindowStore? store,
  }) : _store = store;

  /// Remembers where each window was last placed. Null disables persistence
  /// (used in tests).
  final WindowStore? _store;

  final VoidCallback onOpenFull;
  final VoidCallback onQuit;

  /// Fired when the window returns to POPUP mode.
  ///
  /// Without this the app was a one-way door: `onOpenFull` flipped the widget
  /// into the full Document Viewer and nothing ever flipped it back, so a
  /// later tray click resized the window to 420x620 while still rendering the
  /// 1360-wide viewer inside it — a column-per-letter mess.
  final VoidCallback? onShowPopup;

  bool _popupVisible = false;
  /// True while WE are positioning the window. Suppresses persistence so our
  /// own restore is never mistaken for the user placing the window — without
  /// it, every launch overwrote the remembered position with the default.
  bool _restoring = false;
  /// False until a window has been shown DELIBERATELY (tray click or Open
  /// Vault). Startup fires resize/move events of its own — waitUntilReadyToShow
  /// applies kPopupSize before any mode is chosen — and _popupVisible is false
  /// at that moment, so those events were saved into the FULL slot. The viewer
  /// then restored 420x620 from its own store and looked like a broken layout.
  /// Nothing is persisted until the user has actually placed a window.
  bool _geometryReady = false;
  bool get popupVisible => _popupVisible;

  Future<void> init() async {
    trayManager.addListener(this);
    windowManager.addListener(this);

    await _installTrayIcon();
    await trayManager.setToolTip('Quick2AVault');
    await trayManager.setContextMenu(Menu(items: [
      MenuItem(key: 'open', label: 'Open Vault'),
      MenuItem.separator(),
      MenuItem(key: 'quit', label: 'Quit Quick2AVault'),
    ]));

    // Start hidden: a menubar app should not steal a window on launch.
    // preventClose is required for onWindowClose to fire at all — without it
    // the red button destroys the window and the app is left with a tray icon
    // that opens nothing.
    await windowManager.setPreventClose(true);
    await windowManager.setSkipTaskbar(true);
    await windowManager.hide();
  }

  /// The tray icon. A *_Template.png lets macOS invert it automatically for
  /// light/dark menu bars — without a template image the icon is invisible in
  /// one of them.
  ///
  /// IMPORTANT: pass the ASSET KEY, not a filesystem path. Bundled assets are
  /// not files on disk at runtime, so File(...).existsSync() is always false
  /// and the icon silently never installs — which on macOS means the status
  /// item is never created at all and the app has no way to be opened.
  Future<void> _installTrayIcon() async {
    try {
      await trayManager.setIcon(
        'assets/tray_icon_Template.png',
        isTemplate: true,
      );
      // Belt and braces: if the icon fails to RENDER (wrong pixel size, bad
      // alpha), the status item still exists but shows nothing — an invisible
      // menubar app with no way in. A short title guarantees a visible hit
      // target. macOS shows icon + title together, which is fine.
      await trayManager.setTitle('₹');
    } catch (_) {
      await trayManager.setTitle('₹');
    }
  }

  Future<void> togglePopup() async {
    if (_popupVisible) {
      await hidePopup();
    } else {
      await showPopup();
    }
  }

  Future<void> showPopup() async {
    // Same ordering rule as openFullWindow: declare the mode first, so the
    // resize/move events our own calls generate are attributed to the popup.
    _popupVisible = true;
    _restoring = true;
    try {
      // Order matters: size and position BEFORE show, otherwise the panel flashes
      // at its old geometry. setAsFrameless is done once at startup, not here —
      // calling it repeatedly on macOS can leave the window unmapped.
      //
      // Tell the widget to render the POPUP layout first. openFullWindow() may
      // have switched it to the 1360-wide Document Viewer, and shrinking the
      // window to 420x620 around that layout is what produced the broken,
      // one-letter-per-column interface.
      onShowPopup?.call();
      // openFullWindow() gave the window a normal title bar and put it in the
      // taskbar; both must be undone or the "popup" arrives as a small ordinary
      // window with a title bar rather than a frameless panel.
      await windowManager.setTitleBarStyle(TitleBarStyle.hidden);
      await windowManager.setSkipTaskbar(true);
      await _setSizeSettled(kPopupSize);
      // Where the user last dragged it wins over the tray anchor. Falling back
      // to the anchor only when there is no remembered position keeps first-run
      // behaviour unchanged.
      final saved = _store?.position('popup', displays: await _displayRects());
      if (saved != null) {
        await windowManager.setPosition(saved);
      } else {
        await _anchorUnderTray();
      }
      await windowManager.setAlwaysOnTop(true);
      await windowManager.show();
      // An LSUIElement (accessory) app is not in the Dock and will NOT come
      // forward from show() alone — the window stays mapped-but-offscreen.
      // Activating the app is what actually puts the panel on screen.
      await windowManager.focus();
    } finally {
      _restoring = false;
      _geometryReady = true;
    }
  }

  Future<void> hidePopup() async {
    await windowManager.hide();
    _popupVisible = false;
  }

  /// Position the panel under the status item. tray_manager reports the icon's
  /// screen rect; we centre the popup on it and clamp to the screen edge so a
  /// tray icon near the right corner doesn't push the panel off-screen.
  Future<void> _anchorUnderTray() async {
    try {
      final bounds = await trayManager.getBounds();
      if (bounds == null) {
        await windowManager.center();
        return;
      }
      final x = bounds.left + bounds.width / 2 - kPopupSize.width / 2;
      final y = bounds.top + bounds.height + 6;
      await windowManager.setPosition(Offset(x < 8 ? 8 : x, y));
    } catch (_) {
      await windowManager.center();
    }
  }

  /// Switch from the popup to the full resizable window.
  Future<void> openFullWindow() async {
    // Declare the mode BEFORE touching geometry. setSize/setPosition each fire
    // onWindowResized/onWindowMoved, and _persistGeometry writes to whichever
    // slot _popupVisible names — so setting it afterwards saved the full
    // window's 1360x880 into the POPUP slot (and vice versa on the way back).
    _popupVisible = false;
    // Suppress persistence while WE are the ones moving the window: only a
    // user drag or resize should be remembered, not our own restore.
    _restoring = true;
    try {
      await windowManager.setAlwaysOnTop(false);
      await windowManager.setSkipTaskbar(false);
      await windowManager.setTitleBarStyle(TitleBarStyle.normal);
      // Size and position BEFORE show, so the window appears already correct
      // rather than snapping after it is visible.
      final want = _store?.size('full') ?? kFullSize;
      await _setSizeSettled(want);
      final saved = _store?.position('full', displays: await _displayRects());
      if (saved != null) {
        await windowManager.setPosition(saved);
      } else {
        await windowManager.center();
      }
      await windowManager.show();
      await windowManager.focus();
    } finally {
      _restoring = false;
      // From here on, any resize/move is the USER's and worth remembering.
      _geometryReady = true;
    }
    onOpenFull();
  }

  /// setSize, then verify it actually took.
  ///
  /// waitUntilReadyToShow() applies the popup geometry during startup, and a
  /// setSize issued while that is still settling is silently dropped by AppKit:
  /// the window stayed 420x620 while center() (issued right after) worked
  /// fine — proof the call was reaching the platform but the resize was not
  /// sticking. Verifying and retrying is the only reliable fix; a fixed sleep
  /// either wastes time or is too short on a loaded machine.
  Future<void> _setSizeSettled(Size want) async {
    for (var attempt = 0; attempt < 5; attempt++) {
      await windowManager.setSize(want);
      final got = await windowManager.getSize();
      // Tolerance because macOS rounds to the backing scale factor.
      if ((got.width - want.width).abs() < 2 &&
          (got.height - want.height).abs() < 2) {
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 60));
    }
  }

  /// Screen rects, used to reject a remembered position on a display that is
  /// no longer attached.
  Future<List<Rect>> _displayRects() async {
    try {
      final screens = await ScreenRetriever.instance.getAllDisplays();
      return screens
          .map((d) => Rect.fromLTWH(
                d.visiblePosition?.dx ?? 0,
                d.visiblePosition?.dy ?? 0,
                d.visibleSize?.width ?? d.size.width,
                d.visibleSize?.height ?? d.size.height,
              ))
          .toList();
    } catch (_) {
      // Without display info, accept the saved position rather than discarding
      // it — a wrongly-placed window is recoverable, a lost one is annoying.
      return [const Rect.fromLTWH(-100000, -100000, 200000, 200000)];
    }
  }

  /// Persist wherever the window ended up. Called on move and resize.
  ///
  /// Which slot it writes to follows the CURRENT mode, so dragging the panel
  /// never overwrites the full window's remembered geometry.
  Future<void> _persistGeometry() async {
    if (_store == null || _restoring || !_geometryReady) return;
    try {
      final pos = await windowManager.getPosition();
      final size = await windowManager.getSize();
      await _store!.save(
        _popupVisible ? 'popup' : 'full',
        position: pos,
        size: size,
      );
    } catch (_) {/* geometry is best-effort */}
  }

  @override
  void onWindowMoved() {
    _persistGeometry();
  }

  @override
  void onWindowResized() {
    _persistGeometry();
  }

  // ── TrayListener ──────────────────────────────────────────────────────────
  @override
  void onTrayIconMouseDown() => togglePopup();

  @override
  void onTrayIconRightMouseDown() => trayManager.popUpContextMenu();

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'open':
        openFullWindow();
      case 'quit':
        onQuit();
    }
  }

  /// Closing the full window with its red button must return the app to popup
  /// mode. Otherwise `_fullWindow` stays latched and the next tray click
  /// renders the Document Viewer inside a 420px panel.
  @override
  void onWindowClose() {
    _popupVisible = false;
    onShowPopup?.call();
    windowManager.hide();
  }

  // ── WindowListener ────────────────────────────────────────────────────────
  @override
  void onWindowBlur() {
    // Click-away dismisses the popup, the way a menubar panel should behave.
    // The full window is exempt — losing focus must not hide a real window.
    //
    // Set --dart-define=Q2AV_STICKY_POPUP=true to disable this while
    // screenshotting or filming; a blur-dismissing panel is impossible to
    // capture because the capture itself steals focus.
    const sticky = bool.fromEnvironment('Q2AV_STICKY_POPUP');
    if (_popupVisible && !sticky) hidePopup();
  }

  void dispose() {
    trayManager.removeListener(this);
    windowManager.removeListener(this);
  }
}
