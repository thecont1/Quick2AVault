import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Setup — AI provider, vault location, jurisdiction.
///
/// The AI section is the point: base URL + API key + model for any
/// Anthropic-compatible endpoint. The key is write-only; the daemon returns
/// only a "…abcd" hint so a stored secret can never be read back out.
class SetupView extends StatefulWidget {
  final VaultApi api;
  final VoidCallback onClose;
  const SetupView({super.key, required this.api, required this.onClose});

  @override
  State<SetupView> createState() => _SetupViewState();
}

class _SetupViewState extends State<SetupView> {
  final _baseUrl = TextEditingController();
  final _model = TextEditingController();
  final _apiKey = TextEditingController();

  Map<String, dynamic>? _settings;
  bool _loading = true;
  bool _saving = false;
  String? _message;
  bool _obscure = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await widget.api.settings();
      if (!mounted) return;
      final ai = (s['ai'] ?? const {}) as Map<String, dynamic>;
      setState(() {
        _settings = s;
        _baseUrl.text = (ai['base_url'] ?? '') as String;
        _model.text = (ai['model'] ?? '') as String;
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _message = 'Could not reach the daemon.'; });
    }
  }

  Future<void> _save() async {
    setState(() { _saving = true; _message = null; });
    try {
      final r = await widget.api.saveSettings(
        aiBaseUrl: _baseUrl.text.trim(),
        model: _model.text.trim(),
        apiKey: _apiKey.text.trim(),
      );
      final restart = r['restart_required'] == true;
      if (!mounted) return;
      setState(() {
        _saving = false;
        _apiKey.clear();
        _message = restart
            ? 'Saved. Restart the daemon for the new provider to take effect.'
            : 'Saved.';
      });
      _load();
    } catch (e) {
      if (mounted) setState(() { _saving = false; _message = 'Save failed: $e'; });
    }
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _model.dispose();
    _apiKey.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ai = (_settings?['ai'] ?? const {}) as Map<String, dynamic>;
    final vault = (_settings?['vault'] ?? const {}) as Map<String, dynamic>;
    final juris = (_settings?['jurisdiction'] ?? const {}) as Map<String, dynamic>;

    return Container(
      color: VaultColors.bg,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // Header with the brand mark.
        Container(
          padding: const EdgeInsets.fromLTRB(20, 18, 12, 16),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: VaultColors.line)),
          ),
          child: Row(children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(7),
              child: Image.asset('assets/logo.png',
                  width: 30, height: 30, filterQuality: FilterQuality.medium,
                  errorBuilder: (_, _, _) => const SizedBox(width: 30, height: 30)),
            ),
            const SizedBox(width: 11),
            const Text('Setup',
                style: TextStyle(
                    fontSize: 15, fontWeight: FontWeight.w600, color: VaultColors.primary)),
            const Spacer(),
            _Ghost(label: 'Done', onTap: widget.onClose),
          ]),
        ),
        Expanded(
          child: _loading
              ? const Center(
                  child: SizedBox(
                      width: 18, height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2)))
              : ListView(
                  padding: const EdgeInsets.fromLTRB(20, 18, 20, 30),
                  children: [
                    // ── AI provider ────────────────────────────────────────
                    const _SectionTitle('AI Provider'),
                    const _Hint(
                      'Any Anthropic-compatible endpoint. Leave the base URL '
                      'empty to use Anthropic directly. Extraction, entity '
                      'resolution and reconciliation all run through this.',
                    ),
                    const SizedBox(height: 14),
                    _Field(
                      label: 'Base URL',
                      hint: 'https://api.anthropic.com  (default)',
                      controller: _baseUrl,
                    ),
                    const SizedBox(height: 12),
                    _Field(
                      label: 'Model',
                      hint: 'claude-sonnet-5',
                      controller: _model,
                    ),
                    const SizedBox(height: 12),
                    _Field(
                      label: 'API Key',
                      hint: (ai['api_key_set'] == true)
                          ? 'stored ${ai['api_key_hint']} — type to replace'
                          : 'sk-ant-…',
                      controller: _apiKey,
                      obscure: _obscure,
                      trailing: IconButton(
                        icon: Icon(_obscure ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                            size: 15, color: VaultColors.tertiary),
                        onPressed: () => setState(() => _obscure = !_obscure),
                        splashRadius: 14,
                      ),
                    ),
                    const SizedBox(height: 10),
                    _StatusRow(ai: ai),
                    const SizedBox(height: 16),
                    Row(children: [
                      _Primary(
                        label: _saving ? 'Saving…' : 'Save',
                        onTap: _saving ? null : _save,
                      ),
                      const SizedBox(width: 12),
                      if (_message != null)
                        Expanded(
                          child: Text(_message!,
                              style: TextStyle(
                                  fontSize: 11.5,
                                  color: _message!.startsWith('Save failed') ||
                                          _message!.startsWith('Could not')
                                      ? VaultColors.out
                                      : VaultColors.ok)),
                        ),
                    ]),

                    const SizedBox(height: 28),
                    const _SectionTitle('Vault'),
                    const _Hint('Documents dropped here are archived, read, and filed by transaction date.'),
                    const SizedBox(height: 12),
                    _ReadOnly(label: 'Drop folder', value: (vault['drop'] ?? '') as String),
                    _ReadOnly(label: 'Vault root', value: (vault['root'] ?? '') as String),
                    _ReadOnly(label: 'Ledger', value: (vault['db'] ?? '') as String),

                    const SizedBox(height: 28),
                    const _SectionTitle('Jurisdiction'),
                    const _Hint('Data, not code — financial year, currency and number grouping come from a pack.'),
                    const SizedBox(height: 12),
                    _ReadOnly(label: 'Region', value: '${juris['name'] ?? ''} (${juris['id'] ?? ''})'),
                    _ReadOnly(label: 'Financial year', value: (juris['fy_label'] ?? '') as String),
                    _ReadOnly(label: 'Currency', value: '${juris['currency'] ?? ''} · ${juris['grouping'] ?? ''}'),
                    _ReadOnly(label: 'Date format', value: (juris['date_format'] ?? '') as String),
                  ],
                ),
        ),
      ]),
    );
  }
}

// ── small building blocks ───────────────────────────────────────────────────

class _SectionTitle extends StatelessWidget {
  final String text;
  const _SectionTitle(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text.toUpperCase(),
            style: const TextStyle(
                fontSize: 10, letterSpacing: 1.1,
                fontWeight: FontWeight.w700, color: VaultColors.secondary)),
      );
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);
  @override
  Widget build(BuildContext context) => Text(text,
      style: const TextStyle(fontSize: 11.5, color: VaultColors.tertiary, height: 1.5));
}

class _Field extends StatelessWidget {
  final String label;
  final String hint;
  final TextEditingController controller;
  final bool obscure;
  final Widget? trailing;
  const _Field({
    required this.label,
    required this.hint,
    required this.controller,
    this.obscure = false,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: const TextStyle(fontSize: 11, color: VaultColors.secondary)),
          const SizedBox(height: 5),
          TextField(
            controller: controller,
            obscureText: obscure,
            style: const TextStyle(
                fontSize: 12.5, color: VaultColors.primary, fontFamily: VaultType.mono),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: const TextStyle(
                  fontSize: 12, color: VaultColors.faint, fontFamily: VaultType.mono),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 11),
              filled: true,
              fillColor: VaultColors.controlSubtle,
              suffixIcon: trailing,
              suffixIconConstraints: const BoxConstraints(minWidth: 34, minHeight: 30),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(VaultRadius.control),
                borderSide: const BorderSide(color: VaultColors.line),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(VaultRadius.control),
                borderSide: BorderSide(color: VaultColors.accent.withValues(alpha: 0.7)),
              ),
            ),
          ),
        ],
      );
}

class _StatusRow extends StatelessWidget {
  final Map<String, dynamic> ai;
  const _StatusRow({required this.ai});

  @override
  Widget build(BuildContext context) {
    final ok = ai['available'] == true;
    return Row(children: [
      Container(width: 6, height: 6,
          decoration: BoxDecoration(
              color: ok ? VaultColors.ok : VaultColors.warn, shape: BoxShape.circle)),
      const SizedBox(width: 8),
      Text(
        ok
            ? 'Connected · ${ai['active_model'] ?? ''}'
            : 'No AI provider — documents will be stored but not analysed',
        style: TextStyle(
            fontSize: 11.5, color: ok ? VaultColors.secondary : VaultColors.warn),
      ),
      if (ai['api_key_source'] == 'environment') ...[
        const SizedBox(width: 8),
        const Text('(key from environment)',
            style: TextStyle(fontSize: 10.5, color: VaultColors.faint)),
      ],
    ]);
  }
}

class _ReadOnly extends StatelessWidget {
  final String label;
  final String value;
  const _ReadOnly({required this.label, required this.value});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(
            width: 108,
            child: Text(label,
                style: const TextStyle(fontSize: 11.5, color: VaultColors.tertiary)),
          ),
          Expanded(
            child: SelectableText(value,
                style: const TextStyle(
                    fontSize: 11.5, color: VaultColors.secondary, fontFamily: VaultType.mono)),
          ),
        ]),
      );
}

class _Primary extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;
  const _Primary({required this.label, this.onTap});
  @override
  Widget build(BuildContext context) => MouseRegion(
        cursor: onTap == null ? SystemMouseCursors.basic : SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 9),
            decoration: vaultPill(
              border: VaultColors.accent.withValues(alpha: onTap == null ? 0.25 : 0.6),
              fill: VaultColors.accent.withValues(alpha: onTap == null ? 0.06 : 0.15),
            ),
            child: Text(label,
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: VaultColors.accent.withValues(alpha: onTap == null ? 0.5 : 1))),
          ),
        ),
      );
}

class _Ghost extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _Ghost({required this.label, required this.onTap});
  @override
  Widget build(BuildContext context) => MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
            decoration: vaultPill(),
            child: Text(label,
                style: const TextStyle(fontSize: 11.5, color: VaultColors.secondary)),
          ),
        ),
      );
}
