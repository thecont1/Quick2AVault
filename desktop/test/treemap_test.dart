// Treemap layout — area must be proportional to money.
//
// A treemap is only honest if area equals value. These tests assert that
// geometrically, on the rendered rects, not just on the input data:
//   - a category worth twice as much occupies twice the area
//   - the tiles fill the canvas (no lost rupees in whitespace)
//   - tiles do not overlap (no double-counted pixels)
//
// The squarified algorithm is also checked for its whole purpose: producing
// tiles you can actually compare by eye rather than unreadable slivers.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/treemap.dart';

TreemapNode _n(String id, int minor, {int txns = 1}) => TreemapNode(
      id: id,
      label: id,
      amountMinor: minor,
      transactions: txns,
      known: true,
    );

Future<Map<String, Rect>> _layout(
  WidgetTester tester,
  List<TreemapNode> nodes, {
  Size canvas = const Size(600, 400),
}) async {
  final total = nodes.fold<int>(0, (s, n) => s + n.amountMinor);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: canvas.width,
            height: canvas.height,
            child: Treemap(nodes: nodes, totalMinor: total),
          ),
        ),
      ),
    ),
  );
  final out = <String, Rect>{};
  for (final n in nodes) {
    // Escape the label: RegExp metacharacters in real category names would
    // otherwise silently fail to match, and the loop's `continue` would hide
    // it as "node absent" rather than "test broken". "(none)" is a live label
    // from buildTreemap's passthrough, and its parens are a capture group.
    final f = find.bySemanticsLabel(RegExp('^${RegExp.escape(n.label)},'));
    if (f.evaluate().isEmpty) continue;
    out[n.id] = tester.getRect(f.first);
  }
  return out;
}

void main() {
  testWidgets('area is proportional to value', (tester) async {
    final nodes = [_n('big', 6000), _n('mid', 3000), _n('small', 1000)];
    final rects = await _layout(tester, nodes);

    expect(rects.length, 3, reason: 'every category must be rendered');

    final big = rects['big']!.width * rects['big']!.height;
    final mid = rects['mid']!.width * rects['mid']!.height;
    final small = rects['small']!.width * rects['small']!.height;

    // 6000:3000:1000 -> 6:3:1. Allow 6% for the 1px tile margins.
    expect((big / mid - 2.0).abs() < 0.12, isTrue,
        reason: 'big should be ~2x mid, got ${(big / mid).toStringAsFixed(3)}');
    expect((mid / small - 3.0).abs() < 0.22, isTrue,
        reason: 'mid should be ~3x small, got ${(mid / small).toStringAsFixed(3)}');
  });

  testWidgets('tiles fill the canvas — no rupees lost to whitespace',
      (tester) async {
    const canvas = Size(600, 400);
    final nodes = [
      _n('a', 5000),
      _n('b', 3000),
      _n('c', 2000),
      _n('d', 1200),
      _n('e', 800),
    ];
    final rects = await _layout(tester, nodes, canvas: canvas);
    final covered =
        rects.values.fold<double>(0, (s, r) => s + r.width * r.height);
    final canvasArea = canvas.width * canvas.height;
    // Margins cost a little; anything below 90% means the layout is leaking.
    expect(covered / canvasArea, greaterThan(0.90),
        reason: 'tiles cover only '
            '${(covered / canvasArea * 100).toStringAsFixed(1)}% of the canvas');
  });

  testWidgets('tiles do not overlap', (tester) async {
    final nodes = [
      _n('a', 5000),
      _n('b', 3000),
      _n('c', 2000),
      _n('d', 1000),
    ];
    final rects = (await _layout(tester, nodes)).values.toList();
    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        final o = rects[i].intersect(rects[j]);
        final overlaps = o.width > 1.5 && o.height > 1.5;
        expect(overlaps, isFalse,
            reason: 'tiles $i and $j overlap by '
                '${o.width.toStringAsFixed(1)}x${o.height.toStringAsFixed(1)}');
      }
    }
  });

  testWidgets('squarified: tiles stay comparable, no extreme slivers',
      (tester) async {
    final nodes = [
      _n('a', 4000),
      _n('b', 3000),
      _n('c', 2000),
      _n('d', 1500),
      _n('e', 1000),
      _n('f', 500),
    ];
    final rects = await _layout(tester, nodes);
    for (final e in rects.entries) {
      final r = e.value;
      final ratio =
          r.width > r.height ? r.width / r.height : r.height / r.width;
      // Slice-and-dice routinely exceeds 20:1 here. Squarified should not.
      expect(ratio, lessThan(9.0),
          reason: 'tile ${e.key} is a sliver: '
              '${r.width.toStringAsFixed(0)}x${r.height.toStringAsFixed(0)}');
    }
  });

  testWidgets('largest category is rendered largest', (tester) async {
    final nodes = [_n('biggest', 9000), _n('middle', 4000), _n('least', 900)];
    final rects = await _layout(tester, nodes);
    final areas = {
      for (final e in rects.entries) e.key: e.value.width * e.value.height,
    };
    expect(areas['biggest']!, greaterThan(areas['middle']!));
    expect(areas['middle']!, greaterThan(areas['least']!));
  });

  testWidgets('empty data shows a message, not a blank void', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 400,
          height: 300,
          child: Treemap(nodes: [], totalMinor: 0),
        ),
      ),
    ));
    expect(find.text('No spending in this period'), findsOneWidget);
  });

  testWidgets('a single category fills the whole canvas', (tester) async {
    final rects = await _layout(tester, [_n('only', 1234)]);
    final r = rects['only']!;
    expect(r.width, greaterThan(580));
    expect(r.height, greaterThan(380));
  });

  testWidgets('screen readers get value and share, not just a label',
      (tester) async {
    await _layout(tester, [_n('Groceries', 5000), _n('Transport', 5000)]);
    // Semantics carry the number so the chart is not vision-only.
    expect(find.bySemanticsLabel(RegExp(r'Groceries, ₹50, 50\.0 percent')),
        findsOneWidget);
  });
}
