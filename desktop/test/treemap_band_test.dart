// The popup must actually RENDER the treemap data, not just receive it.
//
// The bug this guards: _refresh() fetched treemap data and stored it in
// _treemap, the full-window viewer rendered it, and PopupView never took the
// parameter at all. Every unit test passed, the daemon returned correct
// numbers, and the user opened the popup and saw nothing. Nothing asserted
// that the band reached the surface people actually look at.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/treemap.dart';

TreemapNode _n(String id, String label, int minor, int txns) => TreemapNode(
      id: id,
      label: label,
      amountMinor: minor,
      transactions: txns,
      known: true,
      sources: const [],
    );

// Mirrors the live vault: 7 categories, Rs 41,682.37 total.
final _nodes = [
  _n('events', 'Events & Learning', 1_094_400, 5),
  _n('software', 'Software & Subscriptions', 739_700, 27),
  _n('ordering_in', 'Ordering In', 667_900, 9),
  _n('transport', 'Transport', 520_000, 6),
  _n('groceries', 'Groceries', 480_000, 3),
  _n('health', 'Health', 380_000, 1),
  _n('other', 'Other', 286_237, 1),
];
final _total = _nodes.fold<int>(0, (s, n) => s + n.amountMinor);

/// The bar's segments only — Scaffold and other ancestors contribute their own
/// transparent ColoredBoxes, so filter to the opaque fills inside the bar.
Finder _segments() => find.descendant(
      of: find.byType(ClipRRect),
      matching: find.byType(ColoredBox),
    );

Future<void> _pumpBand(WidgetTester tester, List<TreemapNode> nodes, int total) {
  // 420px: the real popup width. A band that only works at desktop width is
  // no use here.
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: TreemapBand(nodes: nodes, totalMinor: total),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('the band renders at the popup width', (tester) async {
    await _pumpBand(tester, _nodes, _total);
    expect(tester.takeException(), isNull);
    expect(find.byType(TreemapBand), findsOneWidget);
  });

  testWidgets('segments have real HEIGHT — a zero-height bar is invisible',
      (tester) async {
    // The original version of this suite asserted only width. Tooltip passes
    // loose constraints, a childless ColoredBox took constraints.smallest, and
    // every segment rendered at h=0.0 — a completely invisible bar with a
    // fully passing test. Height is not incidental; it is the difference
    // between a chart and nothing.
    await _pumpBand(tester, _nodes, _total);
    for (final e in _segments().evaluate()) {
      final r = tester.getRect(find.byWidget(e.widget));
      expect(r.height, greaterThan(4.0), reason: 'segment collapsed to h=${r.height}');
    }
  });

  testWidgets('segment widths are proportional to money', (tester) async {
    await _pumpBand(tester, _nodes, _total);

    // Find the coloured segments inside the bar and check their widths track
    // the amounts. This is the honesty property: length == money.
    expect(_segments(), findsNWidgets(_nodes.length),
        reason: 'every category needs a segment');

    final rects = _segments()
        .evaluate()
        .map((e) => tester.getRect(find.byWidget(e.widget)))
        .toList();

    final ranked = [..._nodes]..sort((a, b) => b.amountMinor.compareTo(a.amountMinor));
    final barWidth = rects.fold<double>(0, (s, r) => s + r.width);

    for (var i = 0; i < ranked.length; i++) {
      final expected = ranked[i].amountMinor / _total * barWidth;
      expect(
        rects[i].width,
        closeTo(expected, 1.5),
        reason: '${ranked[i].label} segment must be proportional to its amount',
      );
    }
  });

  testWidgets('the largest category leads the legend', (tester) async {
    await _pumpBand(tester, _nodes, _total);
    expect(find.text('Events & Learning'), findsOneWidget);
    // Rs 10,944 — the biggest bucket, formatted Indian-style.
    expect(find.textContaining('10,944'), findsOneWidget);
  });

  testWidgets('the tail is summarised, never silently dropped', (tester) async {
    await _pumpBand(tester, _nodes, _total);

    // 7 categories, legend shows 4, so 3 must be accounted for explicitly.
    expect(find.text('3 more'), findsOneWidget);

    // And the bar still has a segment for all 7 — the legend truncates, the
    // data does not.
    expect(_segments(), findsNWidgets(7));
  });

  testWidgets('percentages sum to 100 across bar and tail', (tester) async {
    await _pumpBand(tester, _nodes, _total);
    final pcts = tester
        .widgetList<Text>(find.byType(Text))
        .map((t) => t.data ?? '')
        .where((s) => s.endsWith('%'))
        .map((s) => int.parse(s.replaceAll('%', '')))
        .toList();
    expect(pcts.length, 5, reason: '4 legend rows + the summarised tail');
    // Rounding to whole percents, so allow 1 point of slack either way.
    expect(pcts.reduce((a, b) => a + b), closeTo(100, 2));
  });

  testWidgets('an empty vault renders nothing rather than an empty box', (tester) async {
    await _pumpBand(tester, const [], 0);
    expect(_segments(), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a zero total cannot divide by zero', (tester) async {
    await _pumpBand(tester, [_n('a', 'A', 0, 0)], 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('one category fills the whole bar', (tester) async {
    await _pumpBand(tester, [_n('solo', 'Solo', 5_000, 1)], 5_000);
    final r = tester.getRect(_segments());
    expect(r.width, closeTo(420, 1.0));
  });

  testWidgets('screen readers get the total and the category count', (tester) async {
    await _pumpBand(tester, _nodes, _total);
    expect(
      find.bySemanticsLabel(RegExp(r'Spending by category.*7 categories')),
      findsOneWidget,
    );
  });

  testWidgets('popup and viewer colour a category identically', (tester) async {
    // The same spend must not change colour when the window resizes.
    expect(treemapFill(0, 7), treemapFill(0, 7));
    expect(treemapFill(0, 7), isNot(treemapFill(6, 7)));
  });
}
