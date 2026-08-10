library;

import 'package:flutter/material.dart';

import '../../theme.dart';
import 'state.dart';

export 'state.dart';

class AppSettingsView extends StatefulWidget {
  final AppSettings initial;
  final ValueChanged<AppSettings>? onChanged;
  const AppSettingsView({super.key, required this.initial, this.onChanged});

  @override
  State<AppSettingsView> createState() => _AppSettingsViewState();
}

class _AppSettingsViewState extends State<AppSettingsView> {
  late AppSettings _settings;
  @override
  void initState() {
    super.initState();
    _settings = widget.initial;
  }

  @override
  void didUpdateWidget(covariant AppSettingsView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initial != widget.initial) _settings = widget.initial;
  }

  void _change(AppSettings next) {
    setState(() => _settings = next);
    widget.onChanged?.call(next);
  }

  @override
  Widget build(BuildContext context) => ListView(
    key: const PageStorageKey('app-settings'),
    padding: const EdgeInsets.all(24),
    children: [
      const Text(
        'App Settings',
        style: TextStyle(
          fontSize: 21,
          fontWeight: FontWeight.w700,
          color: VaultColors.ink,
        ),
      ),
      const SizedBox(height: 18),
      _SettingsSection(
        title: 'Learning',
        children: [
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: Text(
              _settings.learningEnabled ? 'Learning is on' : 'Learning is off',
            ),
            subtitle: const Text('Corrections still improve future matching.'),
            value: _settings.learningEnabled,
            onChanged: (v) => _change(_settings.copyWith(learningEnabled: v)),
          ),
          const SizedBox(height: 8),
          const Text(
            'Question budget',
            style: TextStyle(
              color: VaultColors.ink,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              ChoiceChip(
                label: const Text('Auto'),
                selected: _settings.questionBudget == null,
                onSelected: (_) =>
                    _change(_settings.copyWith(clearBudget: true)),
              ),
              for (final cap in [3, 5, 8])
                ChoiceChip(
                  label: Text('$cap questions'),
                  selected: _settings.questionBudget == cap,
                  onSelected: (_) =>
                      _change(_settings.copyWith(questionBudget: cap)),
                ),
            ],
          ),
        ],
      ),
      const SizedBox(height: 16),
      _SettingsSection(
        title: 'Intake',
        children: [
          _SettingLine(
            label: 'Drop folder',
            value: _settings.dropFolder ?? 'Not configured',
          ),
          _ToggleLine(
            label: 'Watch for arrivals',
            value: _settings.watcherEnabled,
            onChanged: (v) => _change(_settings.copyWith(watcherEnabled: v)),
          ),
          _ToggleLine(
            label: 'Scan on launch',
            value: _settings.scanOnLaunch,
            onChanged: (v) => _change(_settings.copyWith(scanOnLaunch: v)),
          ),
          _ToggleLine(
            label: 'Move source after successful intake',
            value: _settings.moveOnSuccess,
            onChanged: (v) => _change(_settings.copyWith(moveOnSuccess: v)),
          ),
        ],
      ),
      const SizedBox(height: 16),
      const _SettingsSection(
        title: 'More settings',
        children: [
          Text(
            'AI Provider, Gmail Dropbox, Appearance, Notifications, Categories, Recurring Entries, Storage & Data, Privacy and Advanced are coming soon.',
            style: TextStyle(color: VaultColors.dim, height: 1.45),
          ),
        ],
      ),
    ],
  );
}

class JurisdictionPackView extends StatelessWidget {
  final JurisdictionPack pack;
  final VoidCallback? onAddPack;
  const JurisdictionPackView({
    super.key,
    this.pack = JurisdictionPack.india,
    this.onAddPack,
  });
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(24),
    children: [
      const Text(
        'Jurisdiction Pack',
        style: TextStyle(
          fontSize: 21,
          fontWeight: FontWeight.w700,
          color: VaultColors.ink,
        ),
      ),
      const SizedBox(height: 18),
      Container(
        padding: const EdgeInsets.all(18),
        decoration: vaultCard(border: VaultColors.line),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              pack.name,
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: VaultColors.ink,
              ),
            ),
            const SizedBox(height: 5),
            Text(
              'Active pack · ${pack.currency} · '
              '${pack.financialYearLabel ?? "FY starts month ${pack.financialYearStartMonth}"}',
              style: const TextStyle(color: VaultColors.dim),
            ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      OutlinedButton.icon(
        onPressed: onAddPack,
        icon: const Icon(Icons.add),
        label: const Text('Add pack (coming soon)'),
      ),
    ],
  );
}

class _SettingsSection extends StatelessWidget {
  final String title;
  final List<Widget> children;
  const _SettingsSection({required this.title, required this.children});
  @override
  Widget build(BuildContext context) => Material(
    color: VaultColors.panel,
    shape: RoundedRectangleBorder(
      side: const BorderSide(color: VaultColors.line),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              color: VaultColors.ink,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 10),
          ...children,
        ],
      ),
    ),
  );
}

class _SettingLine extends StatelessWidget {
  final String label;
  final String value;
  const _SettingLine({required this.label, required this.value});
  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(label, style: const TextStyle(color: VaultColors.dim)),
      const Spacer(),
      Flexible(
        child: Text(
          value,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: VaultColors.ink),
        ),
      ),
    ],
  );
}

class _ToggleLine extends StatelessWidget {
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  const _ToggleLine({
    required this.label,
    required this.value,
    required this.onChanged,
  });
  @override
  Widget build(BuildContext context) => SwitchListTile.adaptive(
    contentPadding: EdgeInsets.zero,
    title: Text(label),
    value: value,
    onChanged: onChanged,
  );
}
