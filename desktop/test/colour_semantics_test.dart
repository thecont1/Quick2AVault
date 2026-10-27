// The "where it went" band must be the same colour family as the Spending card.
//
// Why this is a test and not a style opinion: the band breaks SPENDING down by
// category. If spending were one hue and its band another, the chart would
// appear to belong to a different card — the legend and the total it explains
// would be in different hues. Colour is the only thing tying them together, so
// the pairing is a correctness property, not decoration.
//
// Orienteering world (new-work roll): income is yellow open land, spending is
// olive thicket, investments are contour earth, and transfers are blue marsh —
// water, the one terrain that counts toward no total.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/theme.dart';
import 'package:quick2avault_desktop/widgets/treemap.dart';

/// Crude hue family check: is this colour predominantly warm (yellow/ochre)?
bool _isYellowish(Color c) {
  final r = (c.r * 255).round();
  final g = (c.g * 255).round();
  final b = (c.b * 255).round();
  // Yellow open land: red and green clearly ahead of blue.
  return r > b && g > b && (r - b) > 60 && (g - b) > 45;
}

/// Predominantly cool (blue/cyan)?
bool _isBlueish(Color c) {
  final r = (c.r * 255).round();
  final g = (c.g * 255).round();
  final b = (c.b * 255).round();
  return b > r && b > g;
}

/// Predominantly warm (red/orange/brown)?
bool _isWarm(Color c) {
  final r = (c.r * 255).round();
  final b = (c.b * 255).round();
  return r > b;
}

void main() {
  test('Spending is olive, so the band beneath it reads as spending', () {
    // Olive thicket: green-dominant, muted, not blue.
    expect(_isBlueish(VaultColors.spendInk), isFalse,
        reason: 'spendInk must not be blue — blue is marsh, not spending');
    expect(_isBlueish(VaultColors.spendFill), isFalse);
  });

  test('the treemap ramp is the same olive family as the Spending card', () {
    // Every tint of the ramp, not just the darkest.
    for (var i = 0; i < 7; i++) {
      expect(_isBlueish(treemapFill(i, 7)), isFalse,
          reason: 'ramp step $i must stay out of the blue marsh family');
    }
  });

  test('Income is yellow open land — warm, not green', () {
    expect(_isYellowish(VaultColors.incomeInk), isTrue,
        reason: 'income is the yellow open-land region');
    expect(_isYellowish(VaultColors.incomeFill), isTrue);
  });

  test('Investments is contour earth — warm brown', () {
    expect(_isWarm(VaultColors.investInk), isTrue,
        reason: 'investments are the brown contour earth');
    expect(_isBlueish(VaultColors.investInk), isFalse);
  });

  test('every hero colour is distinguishable from the others', () {
    // The real failure mode of a world change: two regions colliding on one
    // hue. Transfer must stay distinct from income/spending/investments.
    final colours = <String, Color>{
      'income': VaultColors.incomeInk,
      'spend': VaultColors.spendInk,
      'invest': VaultColors.investInk,
      'transfer': VaultColors.transfer,
    };
    final seen = <int, String>{};
    for (final e in colours.entries) {
      final key = e.value.toARGB32();
      expect(seen.containsKey(key), isFalse,
          reason: '${e.key} collides with ${seen[key]} — same colour, two meanings');
      seen[key] = e.key;
    }
  });

  test('transfer is blue marsh — cool, distinctly water', () {
    // Marsh blue: a cool hue that reads as water/neutral terrain. It is a
    // real colour family (not grey) but its meaning is "counts toward no
    // total", enforced by being cool while spending is olive-yellow.
    expect(_isBlueish(VaultColors.transfer), isTrue,
        reason: 'transfer is the blue marsh region');
    expect(_isYellowish(VaultColors.transfer), isFalse);
  });
}
