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
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

/// Popup geometry — deliberately narrow, like a menubar utility rather than
/// a document window.
const kPopupSize = Size(420, 620);
const kFullSize = Size(1360, 880);

class MenubarController with TrayListener, WindowListener {
  MenubarController({required this.onOpenFull, required this.onQuit});

  final VoidCallback onOpenFull;
  final VoidCallback onQuit;

  bool _popupVisible = false;
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
    // Order matters: size and position BEFORE show, otherwise the panel flashes
    // at its old geometry. setAsFrameless is done once at startup, not here —
    // calling it repeatedly on macOS can leave the window unmapped.
    await windowManager.setSize(kPopupSize);
    await _anchorUnderTray();
    await windowManager.setAlwaysOnTop(true);
    await windowManager.show();
    // An LSUIElement (accessory) app is not in the Dock and will NOT come
    // forward from show() alone — the window stays mapped-but-offscreen.
    // Activating the app is what actually puts the panel on screen.
    await windowManager.focus();
    _popupVisible = true;
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
    await windowManager.setAlwaysOnTop(false);
    await windowManager.setSkipTaskbar(false);
    await windowManager.setTitleBarStyle(TitleBarStyle.normal);
    await windowManager.setSize(kFullSize);
    await windowManager.center();
    await windowManager.show();
    await windowManager.focus();
    _popupVisible = false;
    onOpenFull();
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
