import 'package:flutter/material.dart';

import 'view.dart';
import 'worlds.dart';
import '../../theme.dart';

class SettingsPanel extends StatelessWidget {
  final AppSettings settings;
  final JurisdictionPack pack;
  final ValueChanged<AppSettings>? onSettingsChanged;
  final VoidCallback? onAddPack;

  const SettingsPanel({
    super.key,
    required this.settings,
    this.pack = JurisdictionPack.india,
    this.onSettingsChanged,
    this.onAddPack,
  });

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    child: Column(
      children: [
        const TabBar(
          tabs: [
            Tab(text: 'App Settings'),
            Tab(text: 'Jurisdiction Pack'),
          ],
        ),
        Expanded(
          child: TabBarView(
            children: [
              ListView(
                padding: const EdgeInsets.only(bottom: 28),
                children: [
                  AppSettingsView(initial: settings, onChanged: onSettingsChanged),
                  const SizedBox(height: 24),
                  const Divider(height: 1),
                  const SizedBox(height: 16),
                  const _ThemesHeading(),
                  const SizedBox(height: 10),
                  const ThemePickerView(compact: true),
                ],
              ),
              JurisdictionPackView(pack: pack, onAddPack: onAddPack),
            ],
          ),
        ),
      ],
    ),
  );
}

class _ThemesHeading extends StatelessWidget {
  const _ThemesHeading();

  @override
  Widget build(BuildContext context) => const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Themes',
            style: TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w700,
              color: VaultColors.ink,
            ),
          ),
          SizedBox(height: 3),
          Text(
            'The whole app takes its ground, ink and accent from the selected theme.',
            style: TextStyle(color: VaultColors.dim, fontSize: 12.5),
          ),
        ],
      );
}

/// Theme picker (the visual worlds). [compact] keeps the tiles tighter for
/// embedding inside App Settings.
class ThemePickerView extends StatelessWidget {
  final bool compact;

  const ThemePickerView({super.key, this.compact = false});

  @override
  Widget build(BuildContext context) {
    final active = worldPalette.value;
    return Column(
      children: [
        for (final palette in const [
          WorldPalette.orienteering,
          WorldPalette.stampPaper,
          WorldPalette.ticketWallet,
        ]) ...[
          _WorldTile(
            palette: palette,
            selected: palette.id == active.id,
            compact: compact,
            onTap: () => worldPalette.value = palette,
          ),
          const SizedBox(height: 10),
        ],
      ],
    );
  }
}

class _WorldTile extends StatelessWidget {
  final WorldPalette palette;
  final bool selected;
  final bool compact;
  final VoidCallback onTap;

  const _WorldTile({
    required this.palette,
    required this.selected,
    required this.compact,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) => Material(
    color: selected
        ? palette.accent.withValues(alpha: 0.08)
        : palette.panel,
    borderRadius: BorderRadius.circular(12),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: EdgeInsets.all(compact ? 10 : 14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: selected ? palette.accent : palette.line,
            width: selected ? 2 : 1,
          ),
        ),
        child: Row(
          children: [
            // Swatch strip
            Container(
              width: compact ? 60 : 72,
              height: compact ? 36 : 44,
              decoration: BoxDecoration(
                color: palette.bg,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: palette.line),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(7),
                child: Row(
                  children: [
                    Expanded(child: ColoredBox(color: palette.incomeFill)),
                    Expanded(child: ColoredBox(color: palette.spendFill)),
                    Expanded(child: ColoredBox(color: palette.investFill)),
                    Expanded(child: ColoredBox(color: palette.accent)),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    palette.id.label,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: VaultColors.ink,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    palette.id.tagline,
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: VaultColors.dim,
                    ),
                  ),
                ],
              ),
            ),
            Icon(
              selected ? Icons.radio_button_checked : Icons.radio_button_off,
              color: selected ? palette.accent : VaultColors.faint,
              size: 20,
            ),
          ],
        ),
      ),
    ),
  );
}
