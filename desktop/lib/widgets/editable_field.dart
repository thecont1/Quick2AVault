import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../theme.dart';

/// A field that can be corrected in place (work order 03 §P3).
///
/// Tap to edit, Enter to save, Esc to cancel. The provenance badge shows who
/// last claimed the value: [user] for a human correction, [ai] for a model
/// reading, plus rule/import.
///
/// SAVE SEMANTICS — optimistic, then reconciled. The new value is shown
/// immediately, but the daemon's resolver decides what is CANONICAL, and it
/// may legitimately disagree: correcting an invoice amount when a settlement
/// document exists leaves the transaction untouched by design. So the widget
/// reports what actually happened rather than assuming the edit won, and
/// surfaces a refusal (409) as an explanation rather than a generic failure.
class EditableField extends StatefulWidget {
  final String label;
  final String field;

  /// The value currently displayed — the RESOLVED value, which is not
  /// necessarily this document's own claim.
  final String? value;

  /// Provenance for this field, or null when nothing has claimed it.
  final FieldClaim? claim;

  /// 'documents' | 'transactions' | 'entities'
  final String subjectType;
  final String subjectId;

  final VaultApi api;

  /// Editing is refused server-side for out-of-scope fields; the caller passes
  /// false to avoid offering an edit the vault will reject.
  final bool editable;

  /// Fixed options — renders a picker instead of a text field. The
  /// zero-typed-input contract for entities, categories and buckets.
  final List<String>? options;

  /// Numeric fields (amounts) get a numeric keyboard and are sent unquoted.
  final bool numeric;

  final void Function(ClaimWriteResult result)? onSaved;

  const EditableField({
    super.key,
    required this.label,
    required this.field,
    required this.subjectType,
    required this.subjectId,
    required this.api,
    this.value,
    this.claim,
    this.editable = true,
    this.options,
    this.numeric = false,
    this.onSaved,
  });

  @override
  State<EditableField> createState() => _EditableFieldState();
}

class _EditableFieldState extends State<EditableField> {
  bool _editing = false;
  bool _saving = false;
  String? _error;
  String? _note;
  late TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.value ?? '');
  }

  @override
  void didUpdateWidget(EditableField old) {
    super.didUpdateWidget(old);
    if (!_editing && old.value != widget.value) {
      _controller.text = widget.value ?? '';
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save(String raw) async {
    final trimmed = raw.trim();
    if (trimmed == (widget.value ?? '').trim()) {
      setState(() => _editing = false);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
      _note = null;
    });
    try {
      final result = await widget.api.writeClaim(
        subjectType: widget.subjectType,
        subjectId: widget.subjectId,
        field: widget.field,
        value: trimmed.isEmpty
            ? null
            : widget.numeric
                ? int.tryParse(trimmed.replaceAll(RegExp(r'[^0-9-]'), '')) ??
                    trimmed
                : trimmed,
      );
      if (!mounted) return;

      // Tell the truth about what the resolver did. An edit that changed no
      // transaction is not a failure — it is the settlement rule, or an
      // orphan document — but the user should not be left believing the
      // ledger moved when it did not.
      final touched =
          result.affected.where((a) => a.changed.isNotEmpty).length;
      final mismatched =
          result.affected.where((a) => a.mismatches.isNotEmpty).toList();

      setState(() {
        _saving = false;
        _editing = false;
        if (touched > 0) {
          _note = '$touched transaction${touched == 1 ? "" : "s"} updated';
        } else if (mismatched.isNotEmpty) {
          final reason = mismatched.first.reasons[widget.field];
          _note = reason == null
              ? 'saved · canonical value unchanged'
              : 'saved · canonical follows the $reason';
        } else if (result.affected.isEmpty) {
          _note = 'saved · not linked to a transaction yet';
        } else {
          _note = 'saved';
        }
      });
      widget.onSaved?.call(result);
    } on ClaimRefusedException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          SizedBox(
            width: 104,
            child: Text(
              widget.label,
              style: const TextStyle(
                  fontSize: 10.5,
                  fontFamily: VaultType.mono,
                  color: VaultColors.faint),
            ),
          ),
          Expanded(child: _editing ? _editor() : _display()),
        ]),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(left: 104, top: 3),
            child: Text(_error!,
                style: const TextStyle(fontSize: 10.5, color: Color(0xFFB3261E))),
          ),
        if (_note != null && _error == null)
          Padding(
            padding: const EdgeInsets.only(left: 104, top: 3),
            child: Text(_note!,
                style: const TextStyle(
                    fontSize: 10.5, color: VaultColors.faint)),
          ),
      ]),
    );
  }

  Widget _display() {
    final empty = (widget.value ?? '').isEmpty;
    return InkWell(
      onTap: widget.editable && !_saving
          ? () => setState(() {
                _editing = true;
                _note = null;
                _controller.text = widget.value ?? '';
              })
          : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          Flexible(
            child: Text(
              empty ? '—' : widget.value!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: empty ? VaultColors.faint : VaultColors.ink,
              ),
            ),
          ),
          const SizedBox(width: 7),
          if (widget.claim != null) _badge(widget.claim!),
          if (_saving) ...[
            const SizedBox(width: 7),
            const SizedBox(
                width: 10,
                height: 10,
                child: CircularProgressIndicator(strokeWidth: 1.4)),
          ],
        ]),
      ),
    );
  }

  Widget _editor() {
    if (widget.options case final opts?) {
      return DropdownButton<String>(
        value: opts.contains(widget.value) ? widget.value : null,
        isDense: true,
        isExpanded: true,
        underline: const SizedBox.shrink(),
        style: const TextStyle(fontSize: 12, color: VaultColors.ink),
        hint: const Text('choose…',
            style: TextStyle(fontSize: 12, color: VaultColors.faint)),
        items: [
          for (final o in opts)
            DropdownMenuItem(value: o, child: Text(o.replaceAll('_', ' '))),
        ],
        onChanged: (v) {
          if (v != null) _save(v);
        },
      );
    }

    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.escape): _CancelIntent(),
      },
      child: Actions(
        actions: {
          _CancelIntent: CallbackAction<_CancelIntent>(
            onInvoke: (_) {
              setState(() {
                _editing = false;
                _error = null;
              });
              return null;
            },
          ),
        },
        child: TextField(
          controller: _controller,
          autofocus: true,
          keyboardType:
              widget.numeric ? TextInputType.number : TextInputType.text,
          style: const TextStyle(fontSize: 12, color: VaultColors.ink),
          decoration: const InputDecoration(
            isDense: true,
            contentPadding: EdgeInsets.symmetric(vertical: 5, horizontal: 7),
            border: OutlineInputBorder(),
          ),
          onSubmitted: _save,
        ),
      ),
    );
  }

  Widget _badge(FieldClaim c) {
    final (bg, fg) = switch (c.source) {
      'user' => (const Color(0xFFEAF6EE), const Color(0xFF16663C)),
      'rule' => (const Color(0xFFEAF2FD), const Color(0xFF1B4F8A)),
      'import' => (const Color(0xFFF2F2F7), VaultColors.dim),
      _ => (const Color(0xFFF7F7FA), VaultColors.faint),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(
        c.source,
        style: TextStyle(
            fontSize: 9, fontFamily: VaultType.mono, color: fg, height: 1.3),
      ),
    );
  }
}

class _CancelIntent extends Intent {
  const _CancelIntent();
}
