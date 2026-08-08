// The "where it went" band must be the same colour family as the Spending card.
//
// Why this is a test and not a style opinion: the band breaks SPENDING down by
// category. When spending was peach and the band was blue, the chart appeared
// to belong to the Investments card sitting right above it — the legend and
// the total it explains were in different hues. Colour is the only thing tying
// them together, so the pairing is a correctness property, not decoration.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/theme.dart';
import 'package:quick2avault_desktop/widgets/treemap.dart';

/// Crude hue family check: is this colour predominantly blue?
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
  test('Spending is blue, so the band beneath it reads as spending', () {
    expect(_isBlueish(VaultColors.spendInk), isTrue,
        reason: 'spendInk must be blue to match the treemap ramp');
    expect(_isBlueish(VaultColors.spendFill), isTrue);
  });

  test('the treemap ramp is the same blue family as the Spending card', () {
    // Every tint of the ramp, not just the darkest.
    for (var i = 0; i < 7; i++) {
      expect(_isBlueish(treemapFill(i, 7)), isTrue,
          reason: 'ramp step $i must stay in the blue family');
    }
  });

  test('Investments is warm, and no longer competes with the band', () {
    expect(_isWarm(VaultColors.investInk), isTrue,
        reason: 'investments took the peach/brown the swap freed up');
    expect(_isBlueish(VaultColors.investInk), isFalse);
  });

  test('Income stays green — the swap must not disturb it', () {
    final g = (VaultColors.incomeInk.g * 255).round();
    final r = (VaultColors.incomeInk.r * 255).round();
    expect(g, greaterThan(r), reason: 'income remains the green anchor');
  });

  test('every hero colour is distinguishable from the others', () {
    // The real failure mode of a swap: two categories colliding on one hue.
    // transfer used to be an ALIAS of investInk, which after the swap would
    // have made transfers and investments the same brown.
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

  test('transfer is neutral, since transfers count toward no total', () {
    // Slate: present but deliberately quiet. A transfer between your own
    // accounts is excluded from spending, income and investments alike.
    final c = VaultColors.transfer;
    final r = (c.r * 255).round();
    final g = (c.g * 255).round();
    final b = (c.b * 255).round();
    final spread = [r, g, b].reduce((a, x) => a > x ? a : x) -
        [r, g, b].reduce((a, x) => a < x ? a : x);
    expect(spread, lessThan(60),
        reason: 'transfer should be near-neutral, not a saturated category hue');
  });
}
