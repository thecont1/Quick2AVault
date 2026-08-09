import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  // A menubar app hides its window rather than closing it. The Flutter
  // template returns `true` here, which quits the process the moment the
  // popup is hidden — the app dies seconds after launch with no error.
  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  // Work order 07 §F: register the native NSStatusItem + NSPopover plugin.
  // The plugin is registered on the main Flutter engine so it can move the
  // FlutterViewController between the main window and the popover.
  override func applicationDidFinishLaunching(_ notification: Notification) {
    if let controller = mainFlutterWindow?.contentViewController as? FlutterViewController {
      PopoverPlugin.register(with: controller.registrar(forPlugin: "PopoverPlugin"))
    }
    super.applicationDidFinishLaunching(notification)
  }
}
