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
  static const incomeFill = Color(0xFFEAF6EE);
  static const incomeBorder = Color(0xFFCDE9D8);
  static const incomeInk = Color(0xFF16663C);

  static const spendFill = Color(0xFFFDF0E6);
  static const spendBorder = Color(0xFFF7DCC5);
  static const spendInk = Color(0xFF9A3412);

  static const investFill = Color(0xFFEAF2FD);
  static const investBorder = Color(0xFFCFE0F7);
  static const investInk = Color(0xFF1B4F86);

  // Accents
  static const accent = Color(0xFF0A84FF); // iOS blue — selected segment
  static const learning = Color(0xFF34C759); // graduation-cap pill
  static const ok = Color(0xFF34C759);
  static const warn = Color(0xFFFF9F0A);

  // Direction language
  static const out = spendInk;
  static const income = incomeInk;
  static const transfer = investInk;

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
