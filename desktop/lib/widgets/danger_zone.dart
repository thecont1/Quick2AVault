import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Destructive vault operations (Settings > Danger Zone).
///
/// Two scopes, because they answer different questions:
///
///   Reset ledger    "the readings are wrong, read my documents again"
///                   Clears documents, transactions, people and learnings.
///                   KEEPS the API key and Gmail connection.
///
///   Factory reset   "forget everything, I'm starting over"
///                   Also clears credentials.
///
/// Neither deletes the user's documents from disk. That is stated plainly in
/// the dialog, because a destructive button people are afraid of is a button
/// they will not use when they need it.
class DangerZone extends StatefulWidget {
  const DangerZone({super.key, required this.api, this.onReset});

  final VaultApi api;
  final VoidCallback? onReset;

  @override
  State<DangerZone> createState() => _DangerZoneState();
}

class _DangerZoneState extends State<DangerZone> {
  bool _busy = false;

  Future<void> _confirmAndReset(String scope) async {
    final isFactory = scope == 'factory';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.warning_amber_rounded, color: Color(0xFFDC2626), size: 32),
        title: Text(isFactory ? 'Factory reset?' : 'Reset the ledger?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              isFactory
                  ? 'This clears everything: documents, transactions, people, '
                      'learnings — and your API key and Gmail connection.'
                  : 'This clears the ledger: documents, transactions, people '
                      'and everything the app has learned.',
              style: const TextStyle(fontSize: 13, height: 1.4),
            ),
            const SizedBox(height: 12),
            if (!isFactory)
              const _Reassurance(
                icon: Icons.vpn_key_outlined,
                text: 'Your API key and Gmail connection are kept.',
              ),
            const _Reassurance(
              icon: Icons.folder_outlined,
              text: 'Your documents on disk are NOT deleted. Drop them back in '
                  'to rebuild the ledger.',
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626)),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(isFactory ? 'Erase everything' : 'Reset ledger'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    setState(() => _busy = true);
    try {
      final r = await widget.api.resetVault(scope: scope);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Cleared ${r.documents} documents, ${r.transactions} transactions, '
            '${r.entities} people, ${r.learnedRules} learned rules.',
          ),
        ),
      );
      widget.onReset?.call();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Reset failed: $e'), backgroundColor: const Color(0xFFDC2626)),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 24),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        border: Border.all(color: const Color(0xFFDC2626).withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(10),
        color: const Color(0xFFDC2626).withValues(alpha: 0.03),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: const [
              Icon(Icons.report_gmailerrorred_outlined, size: 18, color: Color(0xFFDC2626)),
              SizedBox(width: 6),
              Text(
                'Danger zone',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                  color: Color(0xFFDC2626),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'Neither option deletes your documents from disk.',
            style: TextStyle(fontSize: 12, color: VaultColors.tertiary),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              OutlinedButton.icon(
                onPressed: _busy ? null : () => _confirmAndReset('ledger'),
                icon: const Icon(Icons.restart_alt, size: 16),
                label: const Text('Reset ledger'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: const Color(0xFFDC2626),
                  side: const BorderSide(color: Color(0xFFDC2626)),
                ),
              ),
              FilledButton.icon(
                onPressed: _busy ? null : () => _confirmAndReset('factory'),
                icon: _busy
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.delete_forever, size: 16),
                label: const Text('Factory reset'),
                style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Reassurance extends StatelessWidget {
  const _Reassurance({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 15, color: VaultColors.tertiary),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                text,
                style: const TextStyle(fontSize: 12, color: VaultColors.tertiary, height: 1.35),
              ),
            ),
          ],
        ),
      );
}
