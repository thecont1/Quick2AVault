/// Design tokens, ported from the Glaze app's palette.
/// Amber = needs attention, emerald = settled, calm dark surface throughout.
library;

import 'package:flutter/material.dart';

class VaultColors {
  static const bg = Color(0xFF0E1013);
  static const panel = Color(0xFF15181D);
  static const panelAlt = Color(0xFF191D23);
  static const line = Color(0xFF242930);
  static const lineBright = Color(0xFF37404B);

  static const ink = Color(0xFFE6E9EE);
  static const dim = Color(0xFF8B95A3);
  static const faint = Color(0xFF5B6672);

  // Direction colours — from the Glaze renderer's emerald/orange language.
  static const out = Color(0xFFFF6B5E);
  static const income = Color(0xFF3DDC84);
  static const transfer = Color(0xFF7AA2F7);

  static const ok = Color(0xFF3DDC84);
  static const warn = Color(0xFFF0B429);
  static const accent = Color(0xFFFC8019);

  static Color forDirection(String d) => switch (d) {
        'in' => income,
        'transfer' => transfer,
        _ => out,
      };
}

class VaultType {
  static const mono = 'Menlo';
}

final vaultTheme = ThemeData(
  brightness: Brightness.dark,
  scaffoldBackgroundColor: VaultColors.bg,
  colorScheme: const ColorScheme.dark(
    surface: VaultColors.panel,
    primary: VaultColors.accent,
  ),
  fontFamily: '.AppleSystemUIFont',
  useMaterial3: true,
);

/// Money must never reflow as digits change — tabular figures only.
const moneyStyle = TextStyle(
  fontFamily: VaultType.mono,
  fontFeatures: [FontFeature.tabularFigures()],
  fontWeight: FontWeight.w600,
  letterSpacing: -0.5,
);
