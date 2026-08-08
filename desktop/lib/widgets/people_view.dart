import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// People — who this vault is for.
///
/// Most people are DISCOVERED, not declared: the extractor reads "Billed to:"
/// off documents and they appear here with a document count. The dialog exists
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
      if (mounted) setState(() { _loading = false; _message = 'Could not reach the daemon.'; });
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
      if (mounted) setState(() => _message = 'Could not add: $e');
    }
  }

  Future<void> _makeOwner(Person p) async {
    await widget.api.savePerson(
      displayName: p.displayName,
      relationship: p.relationship,
      isMember: true,
      isOwner: true,
    );
    await _load();
  }

  Future<void> _toggleMember(Person p) async {
    await widget.api.savePerson(
      displayName: p.displayName,
      relationship: p.relationship,
      isMember: !p.isMember,
    );
    await _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _relationship.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final owner = _people.where((p) => p.isMember).firstOrNull;

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
            // Only render an exit when there is somewhere to exit TO. As a tab
            // the view has no close action — the tab bar is the way out, and a
            // dead "Done" button would invite a click that does nothing.
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
                      ..._people.map((p) => _PersonRow(
                            person: p,
                            onMakeOwner: () => _makeOwner(p),
                            onToggleMember: () => _toggleMember(p),
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

class _PersonRow extends StatelessWidget {
  final Person person;
  final VoidCallback onMakeOwner;
  final VoidCallback onToggleMember;

  const _PersonRow({
    required this.person,
    required this.onMakeOwner,
    required this.onToggleMember,
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
      padding: const EdgeInsets.fromLTRB(13, 11, 11, 11),
      decoration: vaultCard(
        border: person.isMember
            ? VaultColors.accent.withValues(alpha: 0.45)
            : VaultColors.line,
      ),
      child: Row(children: [
        Container(
          width: 30, height: 30,
          decoration: BoxDecoration(
            color: person.isMember
                ? VaultColors.accent.withValues(alpha: 0.18)
                : VaultColors.controlSubtle,
            shape: BoxShape.circle,
          ),
          alignment: Alignment.center,
          child: Text(initials.isEmpty ? '?' : initials,
              style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: person.isMember ? VaultColors.accent : VaultColors.tertiary)),
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
              if (person.isMember) ...[
                const SizedBox(width: 7),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                  decoration: vaultPill(
                    border: VaultColors.accent.withValues(alpha: 0.5),
                    fill: VaultColors.accent.withValues(alpha: 0.12),
                  ),
                  child: const Text('OWNER',
                      style: TextStyle(
                          fontSize: 8, fontWeight: FontWeight.w700,
                          letterSpacing: 0.5, color: VaultColors.accent)),
                ),
              ],
              if (!person.confirmed) ...[
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                  decoration: vaultPill(
                    border: VaultColors.warn.withValues(alpha: 0.4),
                    fill: VaultColors.warn.withValues(alpha: 0.10),
                  ),
                  child: const Text('DETECTED',
                      style: TextStyle(
                          fontSize: 8, fontWeight: FontWeight.w700,
                          letterSpacing: 0.5, color: VaultColors.warn)),
                ),
              ],
            ]),
            const SizedBox(height: 3),
            Text(
              [
                if (person.relationship != null && person.relationship!.isNotEmpty)
                  person.relationship!,
                '${person.documentCount} document${person.documentCount == 1 ? '' : 's'}',
                if (person.roles.isNotEmpty) person.roles.join(', '),
              ].join(' · '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 10.5, color: VaultColors.tertiary),
            ),
          ]),
        ),
        if (!person.isMember)
          _Ghost(label: 'Make owner', onTap: onMakeOwner, small: true),
      ]),
    );
  }
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
