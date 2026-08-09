import Cocoa
import FlutterMacOS

/// Work order 07 §F — native NSStatusItem + NSPopover bridge.
///
/// The previous implementation used window_manager to simulate a menubar
/// popover with a frameless window positioned under the tray icon. That
/// approach has known issues:
///   - The "popup" is a real window, so it appears in Mission Control and
///     can be focused/unfocused independently of the status item.
///   - Click-away dismissal is manual (onWindowBlur), not the native
///     popover behavior that closes on any click outside.
///   - The window must be resized between popup and full modes, causing
///     visual glitches.
///
/// This plugin creates a native NSPopover anchored to an NSStatusItem.
/// The popover hosts the main FlutterViewController — moved from the main
/// window into the popover when shown, and moved back when the popover
/// closes or the full window is opened. This avoids a second Flutter engine
/// (which would need a separate Dart isolate and duplicate state) while
/// giving the popover true native behavior: transient dismissal, anchoring,
/// and animation.
///
/// The Dart side is responsible for switching the widget tree to the
/// compact popover layout before calling showPopover, and back to the full
/// layout before calling showFullWindow.
class PopoverPlugin: NSObject, FlutterPlugin, NSPopoverDelegate {
  private var statusItem: NSStatusItem?
  private var popover: NSPopover?
  private var channel: FlutterMethodChannel?
  private var mainWindow: NSWindow?
  private var savedContentRect: NSRect = .zero

  static func register(with registrar: FlutterPluginRegistrar) {
    let instance = PopoverPlugin()
    instance.channel = FlutterMethodChannel(
      name: "quick2avault/popover",
      binaryMessenger: registrar.messenger
    )
    instance.channel?.setMethodCallHandler { [weak instance] call, result in
      instance?.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "installStatusItem":
      installStatusItem()
      result(nil)
    case "showPopover":
      showPopover(result: result)
    case "hidePopover":
      hidePopover()
      result(nil)
    case "togglePopover":
      if popover?.isShown == true {
        hidePopover()
        result(false)
      } else {
        showPopover(result: { _ in result(true) })
      }
    case "isPopoverShown":
      result(popover?.isShown ?? false)
    case "showFullWindow":
      showFullWindow(result: result)
    case "dispose":
      dispose()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // ── NSStatusItem ──────────────────────────────────────────────────────────

  private func installStatusItem() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if let existing = self.statusItem {
        NSStatusBar.system.removeStatusItem(existing)
      }
      let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
      if let icon = self.loadTemplateIcon() {
        item.button?.image = icon
        item.button?.image?.isTemplate = true
      } else {
        item.button?.title = "₹"
      }
      item.button?.target = self
      item.button?.action = #selector(self.statusItemClicked)
      item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
      self.statusItem = item
    }
  }

  private func loadTemplateIcon() -> NSImage? {
    let bundle = Bundle.main
    if let url = bundle.url(forResource: "tray_icon_Template", withExtension: "png"),
       let image = NSImage(contentsOf: url) {
      image.isTemplate = true
      return image
    }
    return nil
  }

  @objc private func statusItemClicked() {
    if popover?.isShown == true {
      hidePopover()
      channel?.invokeMethod("onPopoverClosed", arguments: nil)
    } else {
      // Tell Dart to switch to the compact layout, then show.
      channel?.invokeMethod("onPopoverWillShow", arguments: nil) { [weak self] _ in
        self?.showPopover(result: { _ in })
      }
    }
  }

  // ── NSPopover ─────────────────────────────────────────────────────────────

  private func showPopover(result: @escaping FlutterResult) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { result(false); return }
      guard let button = self.statusItem?.button else {
        result(false)
        return
      }

      // Find or create the popover.
      if self.popover == nil {
        let pop = NSPopover()
        pop.behavior = .transient
        pop.animates = true
        pop.delegate = self
        self.popover = pop
      }
      guard let pop = self.popover else { result(false); return }

      if pop.isShown {
        result(true)
        return
      }

      // Move the FlutterViewController from the main window into the popover.
      // This reuses the existing Flutter engine — no second isolate needed.
      // The main window is hidden while the popover is shown.
      if let flutterVC = self.findFlutterViewController() {
        // Remember the main window so we can restore the VC later.
        self.mainWindow = flutterVC.view.window
        self.savedContentRect = self.mainWindow?.frame ?? .zero

        // Remove the VC from the main window and set it as the popover's
        // content. NSPopover manages its own hosting view.
        self.mainWindow?.contentViewController = nil
        pop.contentViewController = flutterVC
      } else {
        result(false)
        return
      }

      // Show anchored to the status item button.
      pop.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      NSApp.activate(ignoringOtherApps: true)

      // Hide the main window while the popover is visible.
      self.mainWindow?.orderOut(nil)

      result(true)
    }
  }

  private func hidePopover() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.popover?.performClose(nil)
    }
  }

  // ── Full window ───────────────────────────────────────────────────────────

  private func showFullWindow(result: @escaping FlutterResult) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { result(false); return }

      // Close the popover first, restoring the FlutterViewController to the
      // main window.
      if let pop = self.popover, pop.isShown {
        let flutterVC = pop.contentViewController
        pop.contentViewController = nil
        if let window = self.mainWindow, let vc = flutterVC {
          window.contentViewController = vc
        }
        pop.performClose(nil)
      }

      // Show and focus the main window.
      if let window = self.mainWindow {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
      }

      result(true)
    }
  }

  // ── NSPopoverDelegate ─────────────────────────────────────────────────────

  func popoverDidClose(_ notification: Notification) {
    // When the popover closes (transient dismissal — click outside), restore
    // the FlutterViewController to the main window and hide it.
    if let pop = self.popover {
      let flutterVC = pop.contentViewController
      pop.contentViewController = nil
      if let window = self.mainWindow, let vc = flutterVC {
        window.contentViewController = vc
      }
    }
    // The main window stays hidden — the app lives in the menubar.
    self.mainWindow?.orderOut(nil)
    self.channel?.invokeMethod("onPopoverClosed", arguments: nil)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private func findFlutterViewController() -> FlutterViewController? {
    for window in NSApp.windows {
      if let vc = window.contentViewController as? FlutterViewController {
        return vc
      }
      if let vc = window.contentViewController?.children.compactMap({ $0 as? FlutterViewController }).first {
        return vc
      }
    }
    return nil
  }

  private func dispose() {
    if let item = statusItem {
      NSStatusBar.system.removeStatusItem(item)
      statusItem = nil
    }
    popover?.performClose(nil)
    popover = nil
  }
}
