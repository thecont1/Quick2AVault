import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    // The default 800x600 is too narrow: the feed rail leaves ~460px for the
    // ledger, which wraps money values mid-number ("₹960." / "09"). A finance
    // UI must never break a figure across lines.
    //
    // Window size comes from MainMenu.xib (contentRect 1360x880).
    // Do NOT set self.minSize here: on macOS 26 the window ends up sized to
    // minSize exactly, overriding the nib's contentRect.
    super.awakeFromNib()
  }
}
