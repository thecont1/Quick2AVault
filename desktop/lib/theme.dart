/// Design tokens ported from the Glaze app.
///
/// Glaze's renderer uses semantic Tailwind tokens rather than raw colours —
/// text-primary/secondary/tertiary, bg-popover, bg-control-subtle,
/// border-panel — with rounded-lg cards and rounded-full pills. Those names are
/// carried over here so the two apps stay recognisably the same product.
library;

import 'package:flutter/material.dart';

class VaultColors {
  // Surfaces
  static const bg = Color(0xFF0E1013);
  static const popover = Color(0xFF16191F); // bg-popover
  static const panel = Color(0xFF15181D);
  static const controlSubtle = Color(0xFF1B2027); // bg-control-subtle
  static const controlSubtle40 = Color(0xFF171B21); // bg-control-subtle/40
  static const line = Color(0xFF242930); // border-panel
  static const lineBright = Color(0xFF37404B);

  // Text
  static const primary = Color(0xFFE6E9EE); // text-primary
  static const secondary = Color(0xFF9AA4B2); // text-secondary
  static const tertiary = Color(0xFF6B7684); // text-tertiary
  static const ink = primary;
  static const dim = secondary;
  static const faint = tertiary;

  // Glaze's semantic accents (orange-9 / green-9 in its palette)
  static const accent = Color(0xFFFC8019); // Swiggy-ish warm accent
  static const orange9 = Color(0xFFF0801A);
  static const green9 = Color(0xFF30A46C);

  // Direction language
  static const out = Color(0xFFFF6B5E);
  static const income = Color(0xFF3DDC84);
  static const transfer = Color(0xFF7AA2F7);

  static const ok = green9;
  static const warn = Color(0xFFF0B429);

  static Color forDirection(String d) => switch (d) {
        'in' => income,
        'transfer' => transfer,
        _ => out,
      };
}

class VaultRadius {
  static const card = 10.0; // rounded-lg
  static const pill = 999.0; // rounded-full
  static const control = 6.0;
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

/// A Glaze-style card: soft corners, subtle panel border, popover surface.
BoxDecoration vaultCard({Color? border, Color? fill}) => BoxDecoration(
      color: fill ?? VaultColors.popover,
      borderRadius: BorderRadius.circular(VaultRadius.card),
      border: Border.all(color: border ?? VaultColors.line),
    );

/// A Glaze-style pill (rounded-full, control-subtle fill).
BoxDecoration vaultPill({Color? border, Color? fill}) => BoxDecoration(
      color: fill ?? VaultColors.controlSubtle,
      borderRadius: BorderRadius.circular(VaultRadius.pill),
      border: Border.all(color: border ?? VaultColors.line),
    );
