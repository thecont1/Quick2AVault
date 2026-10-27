import 'package:flutter/material.dart';

/// The selectable visual worlds (new-work roll).
///
/// Each world is a complete palette — the same token surface as
/// [VaultColors], but full three. The app default (and the incumbent
/// implementation) is the orienteering map; Settings lets the user switch.
enum WorldId {
  orienteering('Orienteering map', 'Course over terrain — the active layer is purple'),
  stampPaper('Stamped paper', 'Judicial instrument stock — green header, red serials'),
  ticketWallet('Ticket wallet', 'Coupon stock — navy & red with carbon figures');

  const WorldId(this.label, this.tagline);
  final String label;
  final String tagline;
}

class WorldPalette {
  const WorldPalette({
    required this.id,
    required this.bg,
    required this.panel,
    required this.controlSubtle,
    required this.controlSubtle40,
    required this.line,
    required this.lineBright,
    required this.ink,
    required this.dim,
    required this.faint,
    required this.accent,
    required this.ok,
    required this.warn,
    required this.incomeFill,
    required this.incomeBorder,
    required this.incomeInk,
    required this.spendFill,
    required this.spendBorder,
    required this.spendInk,
    required this.investFill,
    required this.investBorder,
    required this.investInk,
    required this.transfer,
    required this.categorySwatches,
  });

  final WorldId id;
  final Color bg, panel, controlSubtle, controlSubtle40;
  final Color line, lineBright;
  final Color ink, dim, faint;
  final Color accent, ok, warn;
  final Color incomeFill, incomeBorder, incomeInk;
  final Color spendFill, spendBorder, spendInk;
  final Color investFill, investBorder, investInk;
  final Color transfer;
  final List<Color> categorySwatches;

  static const orienteering = WorldPalette(
    id: WorldId.orienteering,
    bg: Color(0xFFFBF9F3),
    panel: Color(0xFFFFFFFC),
    controlSubtle: Color(0xFFEFEBDF),
    controlSubtle40: Color(0xFFF6F3E9),
    line: Color(0xFFE2DCCB),
    lineBright: Color(0xFFCFC7AE),
    ink: Color(0xFF26241F),
    dim: Color(0xFF615C50),
    faint: Color(0xFF8B856F),
    accent: Color(0xFF6748A8),
    ok: Color(0xFF4E7C3B),
    warn: Color(0xFFB47A1F),
    incomeFill: Color(0xFFF7EFD2),
    incomeBorder: Color(0xFFE8D99F),
    incomeInk: Color(0xFF6A5A12),
    spendFill: Color(0xFFE7E5D4),
    spendBorder: Color(0xFFCBC7A8),
    spendInk: Color(0xFF4E4A2E),
    investFill: Color(0xFFEBDDC8),
    investBorder: Color(0xFFD5BFA0),
    investInk: Color(0xFF7A5528),
    transfer: Color(0xFF3D6C7E),
    categorySwatches: [
      Color(0xFF6B9E52), Color(0xFFC68A3B), Color(0xFF5E8FA8),
      Color(0xFF8B74A8), Color(0xFFA85E5E), Color(0xFFB8A24E),
      Color(0xFF5FA399), Color(0xFF9E93AE),
    ],
  );

  static const stampPaper = WorldPalette(
    id: WorldId.stampPaper,
    bg: Color(0xFFF3EBD9), // buff stamp stock
    panel: Color(0xFFFBF6EA),
    controlSubtle: Color(0xFFE7DCC4),
    controlSubtle40: Color(0xFFEFE7D3),
    line: Color(0xFFD8C9A9),
    lineBright: Color(0xFFC2AF86),
    ink: Color(0xFF32291D),
    dim: Color(0xFF6B5D45),
    faint: Color(0xFF93846A),
    accent: Color(0xFF9E2B25), // stamp red / serial overprint
    ok: Color(0xFF3F6B4F), // seal green
    warn: Color(0xFFB07A16),
    incomeFill: Color(0xFFEBDFB4),
    incomeBorder: Color(0xFFD8C58D),
    incomeInk: Color(0xFF6B5816),
    spendFill: Color(0xFFDEE2C9),
    spendBorder: Color(0xFFC2C89C),
    spendInk: Color(0xFF4D5630),
    investFill: Color(0xFFE7D3BE),
    investBorder: Color(0xFFD3B597),
    investInk: Color(0xFF795332),
    transfer: Color(0xFF5B6E76),
    categorySwatches: [
      Color(0xFF6F8F55), Color(0xFFB58A3E), Color(0xFF5F7F92),
      Color(0xFF8A7094), Color(0xFFA45D4F), Color(0xFFA9913F),
      Color(0xFF5F9486), Color(0xFF8F8499),
    ],
  );

  static const ticketWallet = WorldPalette(
    id: WorldId.ticketWallet,
    bg: Color(0xFFF4F3F1), // coupon stock
    panel: Color(0xFFFFFFFD),
    controlSubtle: Color(0xFFE8E7E4),
    controlSubtle40: Color(0xFFF0EFED),
    line: Color(0xFFDCDAD5),
    lineBright: Color(0xFFC3C0B8),
    ink: Color(0xFF1C2135), // carrier navy ink
    dim: Color(0xFF5A5F73),
    faint: Color(0xFF85899A),
    accent: Color(0xFFC93C36), // carrier red
    ok: Color(0xFF2F6B4F),
    warn: Color(0xFFB07A16),
    incomeFill: Color(0xFFDDF0E7),
    incomeBorder: Color(0xFFB6DCC8),
    incomeInk: Color(0xFF20543A),
    spendFill: Color(0xFFE0E6F2),
    spendBorder: Color(0xFFBFCBE2),
    spendInk: Color(0xFF2A3E66),
    investFill: Color(0xFFF4E8DD),
    investBorder: Color(0xFFE6D0BB),
    investInk: Color(0xFF7A4E2A),
    transfer: Color(0xFF5B6472),
    categorySwatches: [
      Color(0xFF5F8F6A), Color(0xFFC0894A), Color(0xFF5E7FA8),
      Color(0xFF8B74A8), Color(0xFFA85E5E), Color(0xFFB8A24E),
      Color(0xFF5FA399), Color(0xFF9E93AE),
    ],
  );
}

/// Active world. Defaults to the orienteering map (match incumbent code).
final ValueNotifier<WorldPalette> worldPalette =
    ValueNotifier<WorldPalette>(WorldPalette.orienteering);

/// Inherited access to the active world.
class WorldScope extends InheritedNotifier<ValueNotifier<WorldPalette>> {
  const WorldScope({
    super.key,
    required ValueNotifier<WorldPalette> notifier,
    required super.child,
  }) : super(notifier: notifier);

  static WorldPalette of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<WorldScope>();
    return scope?.notifier?.value ?? WorldPalette.orienteering;
  }
}
