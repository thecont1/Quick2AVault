import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Edit one person: rename, set the relationship, make them the owner, delete.
///
/// Renaming keeps the old spelling as an alias so previously-filed documents
/// still match. Renaming onto somebody who already exists is refused — that is
/// a merge decision, and the app asks instead of silently combining two people.
class PersonEditor extends StatefulWidget {
  const PersonEditor({
    super.key,
    required this.api,
    required this.person,
    this.onChanged,
  });

  final VaultApi api;
  final Map<String, dynamic> person;
  final VoidCallback? onChanged;

  @override
  State<PersonEditor> createState() => _PersonEditorState();
}

class _PersonEditorState extends State<PersonEditor> {
  late final TextEditingController _name;
  late final TextEditingController _relationship;
  late bool _isOwner;
  bool _busy = false;
  String? _error;

  String get _id => widget.person['id'] as String;
  String get _originalName => (widget.person['display_name'] as String?) ?? '';

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: _originalName);
    _relationship = TextEditingController(
      text: (widget.person['subtype'] as String?) ?? '',
    );
    _isOwner = (widget.person['is_member'] as num?)?.toInt() == 1;
  }

  @override
  void dispose() {
    _name.dispose();
    _relationship.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'A name is required.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.editPerson(
        _id,
        displayName: name != _originalName ? name : null,
        relationship: _relationship.text.trim(),
        isOwner: _isOwner,
      );
      if (!mounted) return;
      widget.onChanged?.call();
      Navigator.of(context).maybePop();
    } on PersonConflict catch (e) {
      // A name collision is a merge decision, not an error to swallow.
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete ${_originalName}?'),
        content: const Text(
          'The person is removed from the vault. Documents that name them stay, '
          'but lose the link.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626)),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _busy = true);
    try {
      await widget.api.deletePerson(_id);
      if (!mounted) return;
      widget.onChanged?.call();
      Navigator.of(context).maybePop();
    } on PersonInUse catch (e) {
      // The daemon refuses rather than orphaning evidence. Offer the forced
      // path explicitly, with the document count, so the choice is informed.
      if (!mounted) return;
      setState(() => _busy = false);
      final force = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Still in use'),
          content: Text(
            '${e.message}\n\nDeleting anyway unlinks them from '
            '${e.documents} document(s). The documents themselves are kept.',
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626)),
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Unlink and delete'),
            ),
          ],
        ),
      );
      if (force != true || !mounted) return;
      setState(() => _busy = true);
      try {
        await widget.api.deletePerson(_id, force: true);
        if (!mounted) return;
        widget.onChanged?.call();
        Navigator.of(context).maybePop();
      } catch (err) {
        if (mounted) setState(() => _error = '$err');
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Edit person'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _name,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Name',
                helperText: 'The old spelling is kept as an alias.',
                helperMaxLines: 2,
              ),
              onSubmitted: (_) => _save(),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _relationship,
              decoration: const InputDecoration(
                labelText: 'Relationship',
                hintText: 'spouse, parent, colleague…',
              ),
            ),
            const SizedBox(height: 6),
            CheckboxListTile(
              value: _isOwner,
              onChanged: _busy ? null : (v) => setState(() => _isOwner = v ?? false),
              title: const Text('This is me', style: TextStyle(fontSize: 13)),
              subtitle: const Text(
                'Only one person can be the owner.',
                style: TextStyle(fontSize: 11, color: VaultColors.tertiary),
              ),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              dense: true,
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: const Color(0xFFDC2626).withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  _error!,
                  style: const TextStyle(fontSize: 12, color: Color(0xFFDC2626)),
                ),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton.icon(
          onPressed: _busy ? null : _delete,
          icon: const Icon(Icons.delete_outline, size: 16),
          label: const Text('Delete'),
          style: TextButton.styleFrom(foregroundColor: const Color(0xFFDC2626)),
        ),
        const Spacer(),
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Text('Save'),
        ),
      ],
    );
  }
}
