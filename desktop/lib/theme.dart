/// Design tokens — matched to the Quick2A Vault reference design.
///
/// LIGHT theme: white surface, soft tinted cards, iOS-style controls. The
/// three money cards are the anchor — pale green income, pale peach spending,
/// pale blue investments, each with a saturated heading and a large tabular
/// figure right-aligned.
library;

import 'package:flutter/material.dart';

class VaultColors {
  // Surfaces
  static const bg = Color(0xFFFFFFFF);
  static const popover = Color(0xFFFFFFFF);
  static const panel = Color(0xFFFFFFFF);
  static const controlSubtle = Color(0xFFF2F2F7); // iOS grouped background
  static const controlSubtle40 = Color(0xFFF7F7FA);
  static const line = Color(0xFFE5E5EA);
  static const lineBright = Color(0xFFD1D1D6);

  // Text
  static const primary = Color(0xFF1C1C1E);
  static const secondary = Color(0xFF6B6B70);
  static const tertiary = Color(0xFF8E8E93);
  static const ink = primary;
  static const dim = secondary;
  static const faint = tertiary;

  // ── the three money cards ────────────────────────────────────────────────
  // Spending is BLUE and Investments are peach/brown. This is a deliberate
  // swap of the original assignment: the "where it went" band breaks SPENDING
  // down by category and is drawn in the blue treemap ramp, so spending had to
  // own blue for the chart to read as belonging to the card above it. A legend
  // in one hue under a total in another is just a puzzle for the reader.
  static const incomeFill = Color(0xFFEAF6EE);
  static const incomeBorder = Color(0xFFCDE9D8);
  static const incomeInk = Color(0xFF16663C);

  static const spendFill = Color(0xFFEAF2FD);
  static const spendBorder = Color(0xFFCFE0F7);
  static const spendInk = Color(0xFF1B4F86);

  static const investFill = Color(0xFFFDF0E6);
  static const investBorder = Color(0xFFF7DCC5);
  static const investInk = Color(0xFF9A3412);

  // Accents
  static const accent = Color(0xFF0A84FF); // iOS blue — selected segment
  static const learning = Color(0xFF34C759); // graduation-cap pill
  static const ok = Color(0xFF34C759);
  static const warn = Color(0xFFFF9F0A);

  // Direction language
  static const out = spendInk;
  static const income = incomeInk;
  // Transfers get their OWN slate, no longer an alias of investInk. With the
  // card swap that alias would have painted transfers the same brown as
  // Investments — two different meanings in one colour. Slate also carries the
  // right message: a transfer between accounts you own is excluded from every
  // hero total, so it should not wear the livery of a category that counts.
  static const transfer = Color(0xFF5B6472);

  static Color forDirection(String d) => switch (d) {
        'in' => income,
        'transfer' => transfer,
        _ => out,
      };

  /// Watchlist / category palette, in the reference's order.
  static const categorySwatches = <Color>[
    Color(0xFF5FBF8F), // discretionary — green
    Color(0xFFF0A05A), // eating out — orange
    Color(0xFF5AA9E6), // ordering in — blue
    Color(0xFFA78BFA), // groceries — purple
    Color(0xFFE8697D), // AI expense — red
    Color(0xFFF2C94C), // rent & utilities — yellow
    Color(0xFF7DD3C0),
    Color(0xFFB8A6E8),
  ];
}

class VaultRadius {
  static const card = 14.0; // the money cards are notably round
  static const pill = 999.0;
  static const control = 10.0;
}

class VaultType {
  static const mono = 'Menlo';
}

final vaultTheme = ThemeData(
  brightness: Brightness.light,
  scaffoldBackgroundColor: VaultColors.bg,
  colorScheme: const ColorScheme.light(
    surface: VaultColors.panel,
    primary: VaultColors.accent,
  ),
  fontFamily: '.AppleSystemUIFont',
  useMaterial3: true,
);

/// Unbounded — the display face for the app title and the three money card
/// headings. Everything else stays on the system UI font, which is far more
/// legible at small sizes.
const String displayFont = 'Unbounded';

/// Money must never reflow as digits change — tabular figures only.
const moneyStyle = TextStyle(
  fontFamily: '.AppleSystemUIFont',
  fontFeatures: [FontFeature.tabularFigures()],
  fontWeight: FontWeight.w700,
  letterSpacing: -0.8,
);

/// A card in the reference style: soft fill, hairline border, round corners.
BoxDecoration vaultCard({Color? border, Color? fill}) => BoxDecoration(
      color: fill ?? VaultColors.popover,
      borderRadius: BorderRadius.circular(VaultRadius.card),
      border: Border.all(color: border ?? VaultColors.line),
    );

/// A pill (rounded-full).
BoxDecoration vaultPill({Color? border, Color? fill}) => BoxDecoration(
      color: fill ?? VaultColors.controlSubtle,
      borderRadius: BorderRadius.circular(VaultRadius.pill),
      border: Border.all(color: border ?? VaultColors.line),
    );
