import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Squarified treemap of spending by category.
///
/// Tufte: area IS the data. No 3D, no shadows, no gradients, no legend
/// duplicating labels already on the tiles. Colour is one hue at varying
/// tints — it encodes rank, not an arbitrary categorical palette, so it adds
/// no information the area doesn't already carry and never implies that two
/// unrelated categories are related because they share a colour.
///
/// The layout is the squarified algorithm (Bruls, Huizing, van Wijk 2000):
/// greedily add tiles to a row while the worst aspect ratio improves, then
/// commit the row and recurse on what's left. Slice-and-dice is simpler but
/// produces slivers that are impossible to compare by eye — which defeats
/// the point of choosing a treemap.
class Treemap extends StatelessWidget {
  final List<TreemapNode> nodes;
  final int totalMinor;
  final void Function(TreemapNode)? onTap;

  const Treemap({
    super.key,
    required this.nodes,
    required this.totalMinor,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (nodes.isEmpty || totalMinor <= 0) {
      return const _TreemapEmpty();
    }
    return LayoutBuilder(
      builder: (context, box) {
        final rects = _squarify(
          nodes,
          Rect.fromLTWH(0, 0, box.maxWidth, box.maxHeight),
        );
        return Stack(
          children: [
            for (final entry in rects.entries)
              Positioned(
                left: entry.value.left,
                top: entry.value.top,
                width: entry.value.width,
                height: entry.value.height,
                child: _Tile(
                  node: entry.key,
                  rect: entry.value,
                  share: entry.key.amountMinor / totalMinor,
                  rank: nodes.indexOf(entry.key),
                  count: nodes.length,
                  onTap: onTap == null ? null : () => onTap!(entry.key),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// Squarified treemap layout. Returns one rect per node, area proportional to
/// value. Nodes must be sorted descending — the algorithm depends on it.
Map<TreemapNode, Rect> _squarify(List<TreemapNode> nodes, Rect bounds) {
  final out = <TreemapNode, Rect>{};
  final total = nodes.fold<int>(0, (s, n) => s + n.amountMinor);
  if (total <= 0) return out;

  // Work in area units so ratios stay honest regardless of canvas size.
  final scale = bounds.width * bounds.height / total;
  final remaining = [...nodes];
  var rect = bounds;

  while (remaining.isNotEmpty) {
    final row = <TreemapNode>[];
    final shortSide = math.min(rect.width, rect.height);
    var bestRatio = double.infinity;

    // Grow the row while the worst aspect ratio keeps improving.
    while (remaining.isNotEmpty) {
      final trial = [...row, remaining.first];
      final ratio = _worstRatio(trial, shortSide, scale);
      if (row.isNotEmpty && ratio > bestRatio) break;
      bestRatio = ratio;
      row.add(remaining.removeAt(0));
    }

    final rowArea = row.fold<int>(0, (s, n) => s + n.amountMinor) * scale;
    final rowThickness = shortSide == 0 ? 0.0 : rowArea / shortSide;

    var offset = 0.0;
    for (final n in row) {
      final share = rowArea == 0 ? 0.0 : (n.amountMinor * scale) / rowArea;
      if (rect.width >= rect.height) {
        // Row runs vertically down the left edge.
        final h = share * rect.height;
        out[n] = Rect.fromLTWH(rect.left, rect.top + offset, rowThickness, h);
        offset += h;
      } else {
        final w = share * rect.width;
        out[n] = Rect.fromLTWH(rect.left + offset, rect.top, w, rowThickness);
        offset += w;
      }
    }

    // Shrink the canvas by the strip we just filled.
    rect = rect.width >= rect.height
        ? Rect.fromLTWH(rect.left + rowThickness, rect.top,
            math.max(0, rect.width - rowThickness), rect.height)
        : Rect.fromLTWH(rect.left, rect.top + rowThickness, rect.width,
            math.max(0, rect.height - rowThickness));
    if (rect.width <= 0.5 || rect.height <= 0.5) break;
  }
  return out;
}

/// Worst aspect ratio in a candidate row — the quantity squarified minimises.
double _worstRatio(List<TreemapNode> row, double side, double scale) {
  if (row.isEmpty || side <= 0) return double.infinity;
  final areas = row.map((n) => n.amountMinor * scale).toList();
  final sum = areas.fold<double>(0, (s, a) => s + a);
  if (sum <= 0) return double.infinity;
  final maxA = areas.reduce(math.max);
  final minA = areas.reduce(math.min);
  final side2 = side * side;
  final sum2 = sum * sum;
  return math.max(side2 * maxA / sum2, sum2 / (side2 * minA));
}

class _Tile extends StatelessWidget {
  final TreemapNode node;
  final Rect rect;
  final double share;
  final int rank;
  final int count;
  final VoidCallback? onTap;

  const _Tile({
    required this.node,
    required this.rect,
    required this.share,
    required this.rank,
    required this.count,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // One hue, tint by rank: largest darkest. Encodes order, invents nothing.
    final t = count <= 1 ? 0.0 : rank / (count - 1);
    final fill = Color.lerp(
      const Color(0xFF1D4ED8),
      const Color(0xFFDBEAFE),
      t,
    )!;
    final onFill = t < 0.55 ? Colors.white : const Color(0xFF0F2A6B);

    // Below ~46x30 any label is unreadable; leave the tile bare rather than
    // clipping text into noise. Area still carries the value.
    final showLabel = rect.width > 46 && rect.height > 30;
    final showValue = rect.width > 76 && rect.height > 46;

    return Semantics(
      label: '${node.label}, ${_inr(node.amountMinor)}, '
          '${(share * 100).toStringAsFixed(1)} percent, '
          '${node.transactions} transactions',
      button: onTap != null,
      child: Tooltip(
        message: node.sources.length > 1
            ? '${node.label} · ${_inr(node.amountMinor)} · ${node.transactions} txns\n'
                'folded: ${node.sources.map((s) => s.bucket).join(", ")}'
            : '${node.label} · ${_inr(node.amountMinor)} · ${node.transactions} txns',
        waitDuration: const Duration(milliseconds: 400),
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            margin: const EdgeInsets.all(1),
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
            decoration: BoxDecoration(
              color: fill,
              borderRadius: BorderRadius.circular(4),
            ),
            child: !showLabel
                ? const SizedBox.shrink()
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        node.label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: onFill,
                          fontSize: 11.5,
                          height: 1.15,
                          fontWeight: FontWeight.w600,
                          letterSpacing: -0.1,
                        ),
                      ),
                      if (showValue) ...[
                        const SizedBox(height: 2),
                        Text(
                          _inr(node.amountMinor),
                          style: TextStyle(
                            color: onFill.withValues(alpha: 0.92),
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ],
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

class _TreemapEmpty extends StatelessWidget {
  const _TreemapEmpty();
  @override
  Widget build(BuildContext context) => Container(
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0xFFF8FAFC),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xFFE7EAEF)),
        ),
        child: const Text(
          'No spending in this period',
          style: TextStyle(color: Color(0xFF8A9099), fontSize: 12.5),
        ),
      );
}

String _inr(int minor) {
  final rupees = (minor / 100).round();
  final s = rupees.toString();
  if (s.length <= 3) return '₹$s';
  // Indian grouping: last 3, then pairs.
  final head = s.substring(0, s.length - 3);
  final tail = s.substring(s.length - 3);
  final buf = StringBuffer();
  for (var i = 0; i < head.length; i++) {
    if (i > 0 && (head.length - i) % 2 == 0) buf.write(',');
    buf.write(head[i]);
  }
  return '₹$buf,$tail';
}
