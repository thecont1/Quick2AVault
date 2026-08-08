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
}
