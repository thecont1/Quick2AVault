import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// People — who this vault is for.
///
/// Most people are DISCOVERED, not declared: the extractor reads "Billed to:"
/// off documents and they appear here with a document count. The panel exists
/// to confirm them, say who the owner is, and add anyone the documents haven't
/// named yet (a spouse whose bills are in your name, a landlord).
///
/// Kind discipline applies: these are `person` entities and can never merge
/// with a merchant, an account or an instrument.
class PeopleView extends StatefulWidget {
  final VaultApi api;
  final VoidCallback? onClose;
  const PeopleView({super.key, required this.api, required this.onClose});

  @override
  State<PeopleView> createState() => _PeopleViewState();
}

class _PeopleViewState extends State<PeopleView> {
  List<Person> _people = const [];
  bool _loading = true;
  bool _adding = false;
  String? _message;

  /// The currently-expanded person id, or null when no row is open.
  String? _expandedId;

  final _name = TextEditingController();
  final _relationship = TextEditingController();
  bool _newIsMember = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.people();
      if (!mounted) return;
      setState(() {
        _people = r.people;
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _message = VaultError.from(e).message; });
    }
  }

  Future<void> _add() async {
    final name = _name.text.trim();
    if (name.isEmpty) return;
    setState(() => _message = null);
    try {
      await widget.api.savePerson(
        displayName: name,
        relationship: _relationship.text.trim(),
        isMember: _newIsMember,
      );
      _name.clear();
      _relationship.clear();
      if (mounted) setState(() => _adding = false);
      await _load();
    } catch (e) {
      if (mounted) setState(() => _message = VaultError.from(e).message);
    }
  }

  Future<void> _makeOwner(Person p) async {
    await widget.api.editPerson(p.id, isOwner: true);
    await _load();
  }

  void _toggleExpand(Person p) {
    setState(() {
      _expandedId = _expandedId == p.id ? null : p.id;
    });
  }

  @override
  void dispose() {
    _name.dispose();
    _relationship.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final owner = _people.where((p) => p.isOwner).firstOrNull;

    return Container(
      color: VaultColors.bg,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
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
            const Text('People',
                style: TextStyle(
                    fontSize: 15, fontWeight: FontWeight.w600, color: VaultColors.primary)),
            const Spacer(),
            if (widget.onClose != null)
              _Ghost(label: 'Done', onTap: widget.onClose!),
          ]),
        ),
        Expanded(
          child: _loading
              ? const Center(
                  child: SizedBox(
                      width: 18, height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2)))
              : ListView(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 30),
                  children: [
                    Text(
                      owner == null
                          ? 'No owner set yet. People are detected from your documents — '
                            'confirm one as the vault owner.'
                          : 'This vault belongs to ${owner.displayName}.',
                      style: const TextStyle(
                          fontSize: 11.5, color: VaultColors.tertiary, height: 1.5),
                    ),
                    const SizedBox(height: 16),

                    if (_people.isEmpty)
                      const _Empty()
                    else
                      ..._people.map((p) => _PersonEntry(
                            person: p,
                            isExpanded: _expandedId == p.id,
                            api: widget.api,
                            onToggleExpand: () => _toggleExpand(p),
                            onMakeOwner: () => _makeOwner(p),
                            onChanged: _load,
                          )),

                    const SizedBox(height: 16),
                    if (!_adding)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: _Ghost(
                          label: '+ Add someone',
                          onTap: () => setState(() => _adding = true),
                        ),
                      )
                    else
                      _AddForm(
                        name: _name,
                        relationship: _relationship,
                        isMember: _newIsMember,
                        onMemberChanged: (v) => setState(() => _newIsMember = v),
                        onCancel: () => setState(() => _adding = false),
                        onSave: _add,
                      ),

                    if (_message != null) ...[
                      const SizedBox(height: 12),
                      Text(_message!,
                          style: const TextStyle(fontSize: 11.5, color: VaultColors.out)),
                    ],

                    const SizedBox(height: 24),
                    const Text(
                      'People never merge with merchants, accounts or investments — '
                      'even when they share a name.',
                      style: TextStyle(
                          fontSize: 10.5, color: VaultColors.faint, height: 1.5),
                    ),
                  ],
                ),
        ),
      ]),
    );
  }
}

/// A person row that can expand into a detail panel inline.
class _PersonEntry extends StatelessWidget {
  final Person person;
  final bool isExpanded;
  final VaultApi api;
  final VoidCallback onToggleExpand;
  final VoidCallback onMakeOwner;
  final VoidCallback onChanged;

  const _PersonEntry({
    required this.person,
    required this.isExpanded,
    required this.api,
    required this.onToggleExpand,
    required this.onMakeOwner,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final initials = person.displayName
        .split(RegExp(r'\s+'))
        .where((w) => w.isNotEmpty)
        .take(2)
        .map((w) => w[0].toUpperCase())
        .join();

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: vaultCard(
        border: person.isOwner
            ? VaultColors.accent.withValues(alpha: 0.45)
            : VaultColors.line,
      ),
      child: Column(children: [
        // The row header — clickable to expand/collapse.
        MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: onToggleExpand,
            behavior: HitTestBehavior.opaque,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(13, 11, 11, 11),
              child: Row(children: [
                Container(
                  width: 30, height: 30,
                  decoration: BoxDecoration(
                    color: person.isOwner
                        ? VaultColors.accent.withValues(alpha: 0.18)
                        : VaultColors.controlSubtle,
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: Text(initials.isEmpty ? '?' : initials,
                      style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          color: person.isOwner ? VaultColors.accent : VaultColors.tertiary)),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Flexible(
                        child: Text(person.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12.5, color: VaultColors.primary)),
                      ),
                      if (person.isOwner) ...[
                        const SizedBox(width: 7),
                        _Badge(
                          label: 'OWNER',
                          color: VaultColors.accent,
                        ),
                      ],
                      if (person.isMember && !person.isOwner) ...[
                        const SizedBox(width: 6),
                        _Badge(
                          label: 'MEMBER',
                          color: VaultColors.tertiary,
                        ),
                      ],
                      if (!person.confirmed) ...[
                        const SizedBox(width: 6),
                        _Badge(
                          label: 'DETECTED',
                          color: VaultColors.warn,
                        ),
                      ],
                    ]),
                    const SizedBox(height: 3),
                    Text(
                      [
                        if (person.relationship != null && person.relationship!.isNotEmpty)
                          person.relationship!,
                        '${person.documentCount} doc${person.documentCount == 1 ? '' : 's'}',
                        if (person.transactionCount > 0)
                          '${person.transactionCount} txn${person.transactionCount == 1 ? '' : 's'}',
                        if (person.unresolvedAliasCount > 0)
                          '${person.unresolvedAliasCount} unresolved',
                        if (person.roles.isNotEmpty) person.roles.join(', '),
                      ].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10.5, color: VaultColors.tertiary),
                    ),
                  ]),
                ),
                Icon(
                  isExpanded ? Icons.expand_less : Icons.expand_more,
                  size: 18, color: VaultColors.tertiary,
                ),
              ]),
            ),
          ),
        ),
        if (isExpanded)
          _PersonDetailPanel(
            person: person,
            api: api,
            onMakeOwner: onMakeOwner,
            onChanged: onChanged,
          ),
      ]),
    );
  }
}

/// A small pill-shaped badge for OWNER / MEMBER / DETECTED / CONFIRMED.
class _Badge extends StatelessWidget {
  final String label;
  final Color color;
  const _Badge({required this.label, required this.color});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
        decoration: vaultPill(
          border: color.withValues(alpha: 0.5),
          fill: color.withValues(alpha: 0.12),
        ),
        child: Text(label,
            style: TextStyle(
                fontSize: 8, fontWeight: FontWeight.w700,
                letterSpacing: 0.5, color: color)),
      );
}

/// The inline detail panel that appears when a person row is expanded.
///
/// Shows aliases grouped by type, linked documents and transactions, and
/// provides actions for editing, adding/rejecting aliases, merging, deleting,
/// and the detected-person workflow (work order 05 §B.6).
class _PersonDetailPanel extends StatefulWidget {
  final Person person;
  final VaultApi api;
  final VoidCallback onMakeOwner;
  final VoidCallback onChanged;

  const _PersonDetailPanel({
    required this.person,
    required this.api,
    required this.onMakeOwner,
    required this.onChanged,
  });

  @override
  State<_PersonDetailPanel> createState() => _PersonDetailPanelState();
}

class _PersonDetailPanelState extends State<_PersonDetailPanel> {
  PersonDetail? _detail;
  bool _loading = true;
  String? _error;
  bool _busy = false;

  // Inline edit controllers
  late final TextEditingController _name;
  late final TextEditingController _relationship;
  late bool _isOwner;

  // Add-alias controller
  final _aliasInput = TextEditingController();

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.person.displayName);
    _relationship = TextEditingController(text: widget.person.relationship ?? '');
    _isOwner = widget.person.isOwner;
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final d = await widget.api.personDetail(widget.person.id);
      if (!mounted) return;
      setState(() { _detail = d; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _error = VaultError.from(e).message; });
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) return;
    setState(() { _busy = true; _error = null; });
    try {
      await widget.api.editPerson(
        widget.person.id,
        displayName: name != widget.person.displayName ? name : null,
        relationship: _relationship.text.trim(),
        isOwner: _isOwner,
      );
      if (!mounted) return;
      widget.onChanged();
      _load();
    } on PersonConflict catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = VaultError.from(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addAlias() async {
    final value = _aliasInput.text.trim();
    if (value.isEmpty) return;
    setState(() { _busy = true; _error = null; });
    try {
      await widget.api.addPersonAlias(widget.person.id, value);
      _aliasInput.clear();
      _load();
    } on PersonConflict catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = VaultError.from(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _rejectAlias(PersonAlias alias) async {
    setState(() { _busy = true; _error = null; });
    try {
      await widget.api.rejectPersonAlias(widget.person.id, alias.id);
      _load();
    } catch (e) {
      if (mounted) setState(() => _error = VaultError.from(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete ${widget.person.displayName}?'),
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

    setState(() { _busy = true; _error = null; });
    try {
      await widget.api.deletePerson(widget.person.id);
      if (!mounted) return;
      widget.onChanged();
    } on PersonInUse catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      final force = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Still in use'),
          content: Text(
            '${e.message}\n\nDeleting anyway reassigns their evidence to '
            '"Unidentified" on ${e.documents} document(s) — links are kept, '
            'not dropped.',
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
        await widget.api.deletePerson(widget.person.id, force: true);
        if (!mounted) return;
        widget.onChanged();
      } catch (err) {
        if (mounted) setState(() => _error = VaultError.from(err).message);
      }
    } catch (e) {
      if (mounted) setState(() => _error = VaultError.from(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _merge() async {
    // Pick another person to merge FROM (this person is the target).
    final people = await widget.api.people();
    final others = people.people
        .where((p) => p.id != widget.person.id && p.status != 'rejected')
        .toList();
    if (others.isEmpty || !mounted) return;

    final selected = await showDialog<Person>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: Text('Merge another person into ${widget.person.displayName}'),
        children: others.map((p) => SimpleDialogOption(
          onPressed: () => Navigator.pop(ctx, p),
          child: Text(p.displayName),
        )).toList(),
      ),
    );
    if (selected == null || !mounted) return;

    setState(() { _busy = true; _error = null; });
    try {
      await widget.api.mergePeople(fromId: selected.id, intoId: widget.person.id);
      widget.onChanged();
      _load();
    } catch (e) {
      if (mounted) setState(() => _error = VaultError.from(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _relationship.dispose();
    _aliasInput.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: SizedBox(width: 14, height: 14,
            child: CircularProgressIndicator(strokeWidth: 2))),
      );
    }

    final d = _detail;
    return Container(
      padding: const EdgeInsets.fromLTRB(13, 0, 13, 14),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: VaultColors.line)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        // --- Edit section ---
        const SizedBox(height: 12),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Column(children: [
            TextField(
              controller: _name,
              style: const TextStyle(fontSize: 12.5, color: VaultColors.primary),
              decoration: const InputDecoration(
                labelText: 'Name',
                labelStyle: TextStyle(fontSize: 11, color: VaultColors.faint),
                isDense: true,
                contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                filled: true,
                fillColor: VaultColors.controlSubtle,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  borderSide: BorderSide(color: VaultColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  borderSide: BorderSide(color: VaultColors.accent),
                ),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _relationship,
              style: const TextStyle(fontSize: 12.5, color: VaultColors.primary),
              decoration: const InputDecoration(
                labelText: 'Relationship',
                hintText: 'spouse, parent, colleague…',
                labelStyle: TextStyle(fontSize: 11, color: VaultColors.faint),
                isDense: true,
                contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                filled: true,
                fillColor: VaultColors.controlSubtle,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  borderSide: BorderSide(color: VaultColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  borderSide: BorderSide(color: VaultColors.accent),
                ),
              ),
            ),
            const SizedBox(height: 8),
            _Check(
              value: _isOwner,
              label: 'This is me (owner)',
              onChanged: (v) => setState(() => _isOwner = v),
            ),
          ])),
          const SizedBox(width: 10),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            _Ghost(label: 'Save', onTap: _busy ? () {} : _save, small: true),
            const SizedBox(height: 6),
            _Ghost(label: 'Merge…', onTap: _busy ? () {} : _merge, small: true),
            const SizedBox(height: 6),
            _Ghost(
              label: 'Delete',
              onTap: _busy ? () {} : _delete,
              small: true,
            ),
          ]),
        ]),

        if (_error != null) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: const Color(0xFFDC2626).withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(_error!,
                style: const TextStyle(fontSize: 11, color: Color(0xFFDC2626))),
          ),
        ],

        // --- Detected-person workflow ---
        if (!widget.person.confirmed) ...[
          const SizedBox(height: 14),
          const _SectionLabel('Detected person'),
          const SizedBox(height: 6),
          const Text(
            'This person was detected from documents. Confirm them to make '
            'them a permanent identity in the vault.',
            style: TextStyle(fontSize: 11, color: VaultColors.tertiary, height: 1.4),
          ),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 6, children: [
            _Ghost(label: 'Confirm as existing…', onTap: _merge, small: true),
            _Ghost(
              label: 'Create new person',
              onTap: _busy ? () {} : () async {
                setState(() => _busy = true);
                try {
                  await widget.api.editPerson(widget.person.id, displayName: widget.person.displayName);
                  widget.onChanged();
                  _load();
                } catch (e) {
                  if (mounted) setState(() => _error = VaultError.from(e).message);
                } finally {
                  if (mounted) setState(() => _busy = false);
                }
              },
              small: true,
            ),
            _Ghost(
              label: 'Keep separate',
              onTap: () {
                // "Keep separate" dismisses the detection without creating an
                // alias rule. The person stays as-is; no merge, no alias.
                // The row simply collapses on next interaction.
              },
              small: true,
            ),
          ]),
        ],

        // --- Aliases section ---
        const SizedBox(height: 14),
        const _SectionLabel('Aliases'),
        const SizedBox(height: 6),
        if (d != null) ..._aliasGroups(d.aliases),

        // Add alias input
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: TextField(
              controller: _aliasInput,
              style: const TextStyle(fontSize: 12, color: VaultColors.primary),
              decoration: const InputDecoration(
                hintText: 'Add alias (email, phone, name…)',
                hintStyle: TextStyle(fontSize: 11, color: VaultColors.faint),
                isDense: true,
                contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                filled: true,
                fillColor: VaultColors.controlSubtle,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  borderSide: BorderSide(color: VaultColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  borderSide: BorderSide(color: VaultColors.accent),
                ),
              ),
              onSubmitted: (_) => _addAlias(),
            ),
          ),
          const SizedBox(width: 6),
          _Ghost(label: 'Add', onTap: _busy ? () {} : _addAlias, small: true),
        ]),

        // --- Documents section ---
        if (d != null && d.documents.isNotEmpty) ...[
          const SizedBox(height: 14),
          _SectionLabel('Documents (${d.documents.length})'),
          const SizedBox(height: 4),
          ...d.documents.map((doc) => _DocRow(doc)),
        ],

        // --- Transactions section ---
        if (d != null && d.transactions.isNotEmpty) ...[
          const SizedBox(height: 14),
          _SectionLabel('Transactions (${d.transactions.length})'),
          const SizedBox(height: 4),
          ...d.transactions.map((t) => _TxnRow(t)),
        ],
      ]),
    );
  }

  List<Widget> _aliasGroups(List<PersonAlias> aliases) {
    // Group by alias_type, excluding rejected ones from the main display
    // (they're kept in the DB but not shown in the primary list).
    final active = aliases.where((a) => !a.rejected).toList();
    final groups = <String, List<PersonAlias>>{};
    for (final a in active) {
      groups.putIfAbsent(a.aliasType, () => []).add(a);
    }

    final typeLabels = {
      'name_variant': 'Names',
      'email': 'Emails',
      'phone': 'Phones',
      'handle': 'Handles',
    };
    final typeOrder = ['name_variant', 'email', 'phone', 'handle'];

    return typeOrder
        .where((t) => groups.containsKey(t))
        .map((t) => _AliasGroup(
              label: typeLabels[t] ?? t,
              aliases: groups[t]!,
              onReject: _rejectAlias,
            ))
        .toList();
  }
}

class _AliasGroup extends StatelessWidget {
  final String label;
  final List<PersonAlias> aliases;
  final void Function(PersonAlias) onReject;

  const _AliasGroup({required this.label, required this.aliases, required this.onReject});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label,
              style: const TextStyle(
                  fontSize: 10, fontWeight: FontWeight.w600,
                  color: VaultColors.faint, letterSpacing: 0.3)),
          const SizedBox(height: 3),
          ...aliases.map((a) => _AliasRow(alias: a, onReject: () => onReject(a))),
        ]),
      );
}

class _AliasRow extends StatelessWidget {
  final PersonAlias alias;
  final VoidCallback onReject;

  const _AliasRow({required this.alias, required this.onReject});

  @override
  Widget build(BuildContext context) {
    final sourceLabel = alias.source ?? 'unknown';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(alias.alias,
                style: const TextStyle(fontSize: 11.5, color: VaultColors.primary)),
            Text(
              [
                sourceLabel,
                if (alias.proposed) 'proposed',
                if (alias.supportingDocuments > 0)
                  '${alias.supportingDocuments} doc${alias.supportingDocuments == 1 ? '' : 's'}',
                if (alias.lastSeenAt != null)
                  'last seen ${alias.lastSeenAt!.split('T').first}',
              ].join(' · '),
              style: const TextStyle(fontSize: 9.5, color: VaultColors.faint),
            ),
          ]),
        ),
        if (alias.proposed)
          _Ghost(label: 'Reject', onTap: onReject, small: true),
      ]),
    );
  }
}

class _DocRow extends StatelessWidget {
  final Map<String, dynamic> doc;
  const _DocRow(this.doc);

  @override
  Widget build(BuildContext context) {
    final filename = (doc['original_filename'] ?? doc['filename'] ?? '') as String;
    final role = (doc['role'] ?? '') as String;
    final date = ((doc['received_at'] ?? '') as String).split('T').first;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [
        Icon(Icons.description_outlined, size: 13, color: VaultColors.faint),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            '$filename${role.isNotEmpty ? ' · $role' : ''}${date.isNotEmpty ? ' · $date' : ''}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: VaultColors.dim),
          ),
        ),
      ]),
    );
  }
}

class _TxnRow extends StatelessWidget {
  final Txn txn;
  const _TxnRow(this.txn);

  @override
  Widget build(BuildContext context) {
    final date = txn.occurredAt.split('T').first;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [
        Icon(Icons.arrow_outward, size: 13,
            color: txn.direction == 'in' ? VaultColors.ok : VaultColors.out),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            '${txn.sourceAmount} · ${txn.direction} · $date',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
                fontSize: 11, fontFamily: VaultType.mono, color: VaultColors.dim),
          ),
        ),
      ]),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) => Text(text,
      style: const TextStyle(
          fontSize: 10.5, fontWeight: FontWeight.w700,
          color: VaultColors.secondary, letterSpacing: 0.3));
}

class _AddForm extends StatelessWidget {
  final TextEditingController name;
  final TextEditingController relationship;
  final bool isMember;
  final ValueChanged<bool> onMemberChanged;
  final VoidCallback onCancel;
  final VoidCallback onSave;

  const _AddForm({
    required this.name,
    required this.relationship,
    required this.isMember,
    required this.onMemberChanged,
    required this.onCancel,
    required this.onSave,
  });

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: vaultCard(fill: VaultColors.controlSubtle40),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Add someone',
              style: TextStyle(
                  fontSize: 11.5, fontWeight: FontWeight.w600, color: VaultColors.secondary)),
          const SizedBox(height: 10),
          _Input(controller: name, hint: 'Full name', autofocus: true),
          const SizedBox(height: 9),
          _Input(controller: relationship, hint: 'Relationship (spouse, parent, landlord…)'),
          const SizedBox(height: 11),
          Row(children: [
            _Check(
              value: isMember,
              label: 'Shares this vault',
              onChanged: onMemberChanged,
            ),
            const Spacer(),
            _Ghost(label: 'Cancel', onTap: onCancel, small: true),
            const SizedBox(width: 8),
            _Solid(label: 'Add', onTap: onSave),
          ]),
        ]),
      );
}

class _Input extends StatelessWidget {
  final TextEditingController controller;
  final String hint;
  final bool autofocus;
  const _Input({required this.controller, required this.hint, this.autofocus = false});

  @override
  Widget build(BuildContext context) => TextField(
        controller: controller,
        autofocus: autofocus,
        style: const TextStyle(fontSize: 12.5, color: VaultColors.primary),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: const TextStyle(fontSize: 12, color: VaultColors.faint),
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
          filled: true,
          fillColor: VaultColors.controlSubtle,
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(VaultRadius.control),
            borderSide: const BorderSide(color: VaultColors.line),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(VaultRadius.control),
            borderSide: BorderSide(color: VaultColors.accent.withValues(alpha: 0.7)),
          ),
        ),
      );
}

class _Check extends StatelessWidget {
  final bool value;
  final String label;
  final ValueChanged<bool> onChanged;
  const _Check({required this.value, required this.label, required this.onChanged});

  @override
  Widget build(BuildContext context) => MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: () => onChanged(!value),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 14, height: 14,
              decoration: BoxDecoration(
                color: value ? VaultColors.accent.withValues(alpha: 0.9) : Colors.transparent,
                borderRadius: BorderRadius.circular(3),
                border: Border.all(
                    color: value ? VaultColors.accent : VaultColors.lineBright),
              ),
              child: value
                  ? const Icon(Icons.check_rounded, size: 10, color: Colors.white)
                  : null,
            ),
            const SizedBox(width: 7),
            Text(label,
                style: const TextStyle(fontSize: 11.5, color: VaultColors.secondary)),
          ]),
        ),
      );
}

class _Solid extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _Solid({required this.label, required this.onTap});
  @override
  Widget build(BuildContext context) => MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: vaultPill(
              border: VaultColors.accent.withValues(alpha: 0.6),
              fill: VaultColors.accent.withValues(alpha: 0.15),
            ),
            child: Text(label,
                style: const TextStyle(
                    fontSize: 11.5, fontWeight: FontWeight.w600, color: VaultColors.accent)),
          ),
        ),
      );
}

class _Ghost extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  final bool small;
  const _Ghost({required this.label, required this.onTap, this.small = false});
  @override
  Widget build(BuildContext context) => MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            padding: EdgeInsets.symmetric(
                horizontal: small ? 10 : 14, vertical: small ? 5 : 7),
            decoration: vaultPill(),
            child: Text(label,
                style: TextStyle(
                    fontSize: small ? 10.5 : 11.5, color: VaultColors.secondary)),
          ),
        ),
      );
}

class _Empty extends StatelessWidget {
  const _Empty();
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 28),
        alignment: Alignment.center,
        decoration: vaultCard(fill: VaultColors.controlSubtle40),
        child: const Column(children: [
          Text('Nobody detected yet',
              style: TextStyle(fontSize: 12.5, color: VaultColors.secondary)),
          SizedBox(height: 5),
          Text('People appear here as documents name them',
              style: TextStyle(fontSize: 11, color: VaultColors.tertiary)),
        ]),
      );
}
