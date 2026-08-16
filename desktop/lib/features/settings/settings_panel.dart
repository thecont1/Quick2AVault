import 'package:flutter/material.dart';

import 'view.dart';

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
              AppSettingsView(initial: settings, onChanged: onSettingsChanged),
              JurisdictionPackView(pack: pack, onAddPack: onAddPack),
            ],
          ),
        ),
      ],
    ),
  );
}
