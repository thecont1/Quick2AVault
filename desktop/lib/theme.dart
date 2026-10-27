/// Design tokens — matched to the Quick2A Vault reference design.
///
/// LIGHT theme: white surface, soft tinted cards, iOS-style controls. The
/// three money cards are the anchor — pale green income, pale peach spending,
/// pale blue investments, each with a saturated heading and a large tabular
/// figure right-aligned.
library;

import 'package:flutter/material.dart';

import 'features/settings/worlds.dart';

class VaultColors {
  // Surfaces — the orienteering map ground: paper-white runnable forest,
  // olive thicket for secondary surfaces, brown contour hairlines.
  static const bg = Color(0xFFFBF9F3);
  static const popover = Color(0xFFFFFFFC);
  static const panel = Color(0xFFFFFFFC);
  static const controlSubtle = Color(0xFFEFEBDF); // olive thicket tint
  static const controlSubtle40 = Color(0xFFF6F3E9);
  static const line = Color(0xFFE2DCCB); // contour hairline
  static const lineBright = Color(0xFFCFC7AE); // contour, heavier

  // Text
  static const primary = Color(0xFF26241F);
  static const secondary = Color(0xFF615C50);
  static const tertiary = Color(0xFF8B856F);
  static const ink = primary;
  static const dim = secondary;
  static const faint = tertiary;

  // ── the three money cards — map regions ─────────────────────────────
  // Income = yellow open land. Spending = olive thicket. Investments = the
  // brown contour earth. Transfers = blue marsh (water, neutral).
  static const incomeFill = Color(0xFFF7EFD2);
  static const incomeBorder = Color(0xFFE8D99F);
  static const incomeInk = Color(0xFF6A5A12);

  static const spendFill = Color(0xFFE7E5D4);
  static const spendBorder = Color(0xFFCBC7A8);
  static const spendInk = Color(0xFF4E4A2E);

  static const investFill = Color(0xFFEBDDC8);
  static const investBorder = Color(0xFFD5BFA0);
  static const investInk = Color(0xFF7A5528);

  // Accents
  static const accent = Color(0xFF6748A8); // course purple — the active layer
  static const learning = Color(0xFF4E7C3B); // open-land olive-green
  static const ok = Color(0xFF4E7C3B);
  static const warn = Color(0xFFB47A1F);

  // Direction language
  static const out = spendInk;
  static const income = incomeInk;
  static const transfer = Color(0xFF3D6C7E); // blue marsh

  static Color forDirection(String d) => switch (d) {
        'in' => income,
        'transfer' => transfer,
        _ => out,
      };

  /// Watchlist / category palette — map-legend hues.
  static const categorySwatches = <Color>[
    Color(0xFF6B9E52), // discretionary — green
    Color(0xFFC68A3B), // eating out — ochre
    Color(0xFF5E8FA8), // ordering in — lake blue
    Color(0xFF8B74A8), // groceries — heather purple
    Color(0xFFA85E5E), // AI expense — rust
    Color(0xFFB8A24E), // rent & utilities — tannin yellow
    Color(0xFF5FA399),
    Color(0xFF9E93AE),
  ];
}

class VaultRadius {
  static const card = 14.0; // the money cards are notably round
  static const pill = 999.0;
  static const control = 10.0;
}

/// Elevation tokens — the Glass Ledger's depth vocabulary.
///
/// Flat by default; shadow appears only on floating surfaces and on hover
/// (see DESIGN.md → Elevation & Depth). Values are the soft, ambient
/// shadows recorded in the design system sidecar.
class VaultShadows {
  /// Interactive cards, dropdown surfaces, popovers — on hover/press.
  static const elevatedCard = <BoxShadow>[
    BoxShadow(
      color: Color(0x0D0F1C2D), // rgba(15,28,45,.05)
      blurRadius: 2,
      offset: Offset(0, 1),
    ),
    BoxShadow(
      color: Color(0x140F1C2D), // rgba(15,28,45,.08)
      blurRadius: 18,
      offset: Offset(0, 6),
    ),
  ];

  /// The document preview card — the one surface that detaches from the
  /// page at rest.
  static const elevatedFloat = <BoxShadow>[
    BoxShadow(
      color: Color(0x1A0F1C2D), // rgba(15,28,45,.10)
      blurRadius: 8,
      offset: Offset(0, 2),
    ),
    BoxShadow(
      color: Color(0x1F0F1C2D), // rgba(15,28,45,.12)
      blurRadius: 28,
      offset: Offset(0, 10),
    ),
  ];
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
    secondary: VaultColors.accent,
  ),
  fontFamily: '.AppleSystemUIFont',
  useMaterial3: true,
  // Glass Ledger component defaults — every default control across all tabs
  // inherits the tokens; per-surface override only where a surface needs to
  // be deliberately different (e.g. the Review toggle).
  filledButtonTheme: FilledButtonThemeData(
    style: ButtonStyle(
      backgroundColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.disabled)
              ? VaultColors.controlSubtle
              : states.contains(WidgetState.hovered)
                  ? const Color(0xFF0074E5)
                  : VaultColors.accent),
      foregroundColor: WidgetStateProperty.all(VaultColors.panel),
      textStyle: WidgetStateProperty.all(const TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w600,
      )),
      padding: WidgetStateProperty.all(
        const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      ),
      shape: WidgetStateProperty.all(
        RoundedRectangleBorder(borderRadius: BorderRadius.circular(VaultRadius.control)),
      ),
    ),
  ),
  outlinedButtonTheme: OutlinedButtonThemeData(
    style: ButtonStyle(
      foregroundColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.hovered)
              ? VaultColors.accent
              : VaultColors.ink),
      backgroundColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.hovered)
              ? VaultColors.controlSubtle40
              : VaultColors.panel),
      side: WidgetStateProperty.all(BorderSide(color: VaultColors.line)),
      textStyle: WidgetStateProperty.all(const TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w600,
      )),
      padding: WidgetStateProperty.all(
        const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      ),
      shape: WidgetStateProperty.all(
        RoundedRectangleBorder(borderRadius: BorderRadius.circular(VaultRadius.control)),
      ),
    ),
  ),
  textButtonTheme: TextButtonThemeData(
    style: ButtonStyle(
      foregroundColor: WidgetStateProperty.all(VaultColors.accent),
      textStyle: WidgetStateProperty.all(const TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w600,
      )),
    ),
  ),
  inputDecorationTheme: InputDecorationTheme(
    filled: true,
    fillColor: VaultColors.controlSubtle40,
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
    hintStyle: const TextStyle(color: VaultColors.tertiary, fontSize: 13),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(VaultRadius.control),
      borderSide: const BorderSide(color: VaultColors.line),
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(VaultRadius.control),
      borderSide: const BorderSide(color: VaultColors.line),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(VaultRadius.control),
      borderSide: const BorderSide(color: VaultColors.lineBright),
    ),
  ),
  chipTheme: ChipThemeData(
    backgroundColor: VaultColors.controlSubtle,
    selectedColor: VaultColors.accent.withValues(alpha: 0.12),
    side: const BorderSide(color: VaultColors.line),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(VaultRadius.pill)),
    labelStyle: const TextStyle(
      fontSize: 12,
      fontWeight: FontWeight.w600,
      color: VaultColors.secondary,
    ),
    secondaryLabelStyle: const TextStyle(
      fontSize: 12,
      fontWeight: FontWeight.w600,
      color: VaultColors.accent,
    ),
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
  ),
  segmentedButtonTheme: SegmentedButtonThemeData(
    style: ButtonStyle(
      backgroundColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected)
              ? VaultColors.accent.withValues(alpha: 0.12)
              : VaultColors.controlSubtle40),
      foregroundColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected)
              ? VaultColors.accent
              : VaultColors.secondary),
      textStyle: WidgetStateProperty.all(const TextStyle(
        fontSize: 12.5,
        fontWeight: FontWeight.w600,
      )),
      padding: WidgetStateProperty.all(
        const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      ),
      shape: WidgetStateProperty.all(
        RoundedRectangleBorder(borderRadius: BorderRadius.circular(VaultRadius.control)),
      ),
    ),
  ),
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

/// Theme for the active world. Component styles keep the token architecture;
/// the world swap changes shell surfaces, primary accents and semantics
/// (hero cards / treemap / course accents read the palette via WorldScope).
ThemeData vaultThemeFor(WorldPalette palette) => vaultTheme.copyWith(
      scaffoldBackgroundColor: palette.bg,
      canvasColor: palette.bg,
      colorScheme: ColorScheme.light(
        surface: palette.panel,
        primary: palette.accent,
        secondary: palette.accent,
        error: palette.warn,
      ),
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
