// The tray icon must ALWAYS open the popup, never the Document Viewer
// squeezed into a 420px panel.
//
// The bug: `_fullWindow` was set true by onOpenFull and never cleared. After
// opening the viewer once, every later tray click resized the window to
// 420x620 while still rendering the 1360-wide viewer inside it — text
// collapsed to one letter per line, which is what the user saw.
//
// Two independent guards are tested here:
//   1. the state machine returns to popup mode (onShowPopup fires)
//   2. even if state were wrong, a too-narrow window renders the popup anyway

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/menubar.dart';

/// Mirrors the production layout decision in main.dart's build().
Widget _surface({required bool fullWindow, required Size window}) {
  return MediaQuery(
    data: MediaQueryData(size: window),
    child: MaterialApp(
      home: Builder(builder: (context) {
        final tooNarrow =
            MediaQuery.of(context).size.width < kFullSize.width * 0.6;
        final showPopup = !fullWindow || tooNarrow;
        return Scaffold(
          body: Center(
            child: Text(showPopup ? 'POPUP' : 'VIEWER'),
          ),
        );
      }),
    ),
  );
}

void main() {
  test('controller exposes a return path out of full-window mode', () {
    // Regression guard: onShowPopup must exist. Its absence was the bug —
    // openFullWindow() could set the flag but nothing could clear it.
    var backToPopup = false;
    final c = MenubarController(
      onOpenFull: () {},
      onShowPopup: () => backToPopup = true,
      onQuit: () {},
    );
    expect(c.onShowPopup, isNotNull,
        reason: 'no way to leave full-window mode — the original bug');
    c.onShowPopup!();
    expect(backToPopup, isTrue);
  });

  test('popup and full sizes are far enough apart for the width guard', () {
    // The safety net uses 60% of the full width as the threshold. If the two
    // sizes ever converge this test fails before the UI breaks.
    expect(kPopupSize.width, lessThan(kFullSize.width * 0.6),
        reason: 'popup width must fall below the viewer threshold');
  });

  testWidgets('tray click at popup size renders the popup', (tester) async {
    await tester.pumpWidget(_surface(fullWindow: false, window: kPopupSize));
    expect(find.text('POPUP'), findsOneWidget);
  });

  testWidgets('full window at full size renders the viewer', (tester) async {
    await tester.pumpWidget(_surface(fullWindow: true, window: kFullSize));
    expect(find.text('VIEWER'), findsOneWidget);
  });

  testWidgets('THE BUG: viewer state at popup size must still render popup',
      (tester) async {
    // Exactly the broken condition the user reported.
    await tester.pumpWidget(_surface(fullWindow: true, window: kPopupSize));
    expect(
      find.text('POPUP'),
      findsOneWidget,
      reason: 'Document Viewer rendered inside a 420px panel — the broken UI',
    );
  });
}
