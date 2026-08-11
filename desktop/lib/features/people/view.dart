library;

import 'package:flutter/material.dart';

import '../../theme.dart';
import 'state.dart';

export 'state.dart';

/// Entity desk: kinds are visually explicit and all destructive actions stay
/// scoped to the selected kind.
///
/// WO11 Track A wires the three actions the data layer always supported:
///   * [onSetOwner]     — exclusive owner toggle, person + confirmed only
///   * [onMerge]        — same-kind merge, behind a confirmation dialog
///   * [onKeepSeparate] — dismiss a cross-kind identifier collision
class EntityDesk extends StatefulWidget {
  final List<EntitySummary> entities;
  final ValueChanged<EntitySummary>? onSelected;
  final void Function(EntitySummary entity, bool owner)? onSetOwner;
  final void Function(EntitySummary source, EntitySummary target)? onMerge;
  final void Function(EntitySummary entity, EntityConflict conflict)?
  onKeepSeparate;
  const EntityDesk({
    super.key,
    required this.entities,
    this.onSelected,
    this.onSetOwner,
    this.onMerge,
    this.onKeepSeparate,
  });
  @override
  State<EntityDesk> createState() => _EntityDeskState();
}

class _EntityDeskState extends State<EntityDesk> {
  String? _selected;
  @override
  Widget build(BuildContext context) {
    final selected = widget.entities
        .where((e) => e.id == _selected)
        .firstOrNull;
    return LayoutBuilder(
      builder: (context, constraints) {
        final narrow = constraints.maxWidth < 620;
        final list = _EntityList(
          entities: widget.entities,
          selectedId: _selected,
          onSelect: (entity) {
            setState(() => _selected = entity.id);
            widget.onSelected?.call(entity);
          },
        );
        final detail = selected == null
            ? const _EntityEmpty()
            : _EntityDetail(
                entity: selected,
                entities: widget.entities,
                onSetOwner: widget.onSetOwner,
                onMerge: widget.onMerge,
                onKeepSeparate: widget.onKeepSeparate,
              );
        return narrow
            ? Column(
                children: [
                  Expanded(child: list),
                  if (selected != null) Expanded(child: detail),
                ],
              )
            : Row(
                children: [
                  SizedBox(width: 310, child: list),
                  const VerticalDivider(width: 1),
                  Expanded(child: detail),
                ],
              );
      },
    );
  }
}

class _EntityList extends StatelessWidget {
  final List<EntitySummary> entities;
  final String? selectedId;
  final ValueChanged<EntitySummary> onSelect;
  const _EntityList({
    required this.entities,
    required this.selectedId,
    required this.onSelect,
  });
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      Text(
        '${entities.length} entities',
        style: const TextStyle(color: VaultColors.dim, fontSize: 12),
      ),
      const SizedBox(height: 9),
      if (entities.isEmpty) const _EntityEmpty(),
      for (final entity in entities)
        _EntityRow(
          entity: entity,
          selected: entity.id == selectedId,
          onTap: () => onSelect(entity),
        ),
    ],
  );
}

class _EntityRow extends StatelessWidget {
  final EntitySummary entity;
  final bool selected;
  final VoidCallback onTap;
  const _EntityRow({
    required this.entity,
    required this.selected,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    label: '${entity.name}, ${entity.kind.label}',
    child: InkWell(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: selected ? VaultColors.controlSubtle : null,
          border: Border.all(
            color: selected
                ? VaultColors.accent.withValues(alpha: .45)
                : VaultColors.line,
          ),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            Icon(
              switch (entity.kind) {
                EntityKind.person => Icons.person_outline,
                EntityKind.organisation => Icons.business_outlined,
                EntityKind.account => Icons.account_balance_outlined,
              },
              size: 17,
              color: VaultColors.dim,
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                entity.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: VaultColors.ink,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            // WO11 A1: the owner badge — the single "self" this vault is for.
            if (entity.owner)
              const Tooltip(
                message: 'Owner',
                child: Icon(Icons.star, size: 14, color: VaultColors.accent),
              ),
            if (entity.owner) const SizedBox(width: 6),
            _KindBadge(entity: entity),
          ],
        ),
      ),
    ),
  );
}

class _KindBadge extends StatelessWidget {
  final EntitySummary entity;
  const _KindBadge({required this.entity});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: vaultPill(
      fill: VaultColors.controlSubtle,
      border: VaultColors.line,
    ),
    child: Text(
      entity.kind == EntityKind.account && entity.last4 != null
          ? 'account · ••••${entity.last4}'
          : entity.kind.label,
      style: const TextStyle(
        fontSize: 10,
        color: VaultColors.dim,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

class _EntityEmpty extends StatelessWidget {
  const _EntityEmpty();
  @override
  Widget build(BuildContext context) => const Center(
    child: Padding(
      padding: EdgeInsets.all(28),
      child: Text('No entities yet', style: TextStyle(color: VaultColors.dim)),
    ),
  );
}

/// "a person" / "an organisation" / "an account" — the conflict card copy
/// names both kinds, and English articles are not optional.
String _indefinite(String noun) =>
    noun.startsWith(RegExp(r'^[aeiou]')) ? 'an $noun' : 'a $noun';

class _EntityDetail extends StatelessWidget {
  final EntitySummary entity;
  final List<EntitySummary> entities;
  final void Function(EntitySummary entity, bool owner)? onSetOwner;
  final void Function(EntitySummary source, EntitySummary target)? onMerge;
  final void Function(EntitySummary entity, EntityConflict conflict)?
  onKeepSeparate;
  const _EntityDetail({
    required this.entity,
    required this.entities,
    this.onSetOwner,
    this.onMerge,
    this.onKeepSeparate,
  });

  /// Merge candidates: same kind, confirmed, not this entity. You merge INTO
  /// a confirmed entity — never into an unconfirmed candidate, and never
  /// across kinds (the daemon refuses cross-kind merges regardless).
  List<EntitySummary> get _mergeCandidates => entities
      .where(
        (e) => e.id != entity.id && e.kind == entity.kind && e.confirmed,
      )
      .toList();

  Future<void> _confirmOwner(BuildContext context) async {
    final action = onSetOwner;
    if (action == null) return;
    final making = !entity.owner;
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(making ? 'Make owner?' : 'Unset owner?'),
        content: Text(
          making
              ? 'Make ${entity.name} the owner of this vault? The previous owner is unset in the same write.'
              : 'Unset ${entity.name} as owner? The vault will have no owner until you pick one.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(making ? 'Make owner' : 'Unset owner'),
          ),
        ],
      ),
    );
    if (yes == true) action(entity, making);
  }

  Future<void> _pickMergeTarget(BuildContext context) async {
    final action = onMerge;
    if (action == null) return;
    final candidates = _mergeCandidates;
    final target = await showDialog<EntitySummary>(
      context: context,
      builder: (context) => SimpleDialog(
        title: Text('Merge ${entity.name} with…'),
        children: [
          for (final candidate in candidates)
            SimpleDialogOption(
              onPressed: () => Navigator.of(context).pop(candidate),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      candidate.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  // Two entities can share a display name — the email or
                  // account last-4 makes the pick unambiguous.
                  if (candidate.email != null || candidate.last4 != null)
                    Text(
                      candidate.email ?? '••••${candidate.last4}',
                      style: const TextStyle(
                        color: VaultColors.dim,
                        fontSize: 12,
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
    if (target == null || !context.mounted) return;
    // The second confirmation is mandatory: a merge is destructive and
    // unmerging is not supported. The dialog states the predicted rule.
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Merge ${entity.name}?'),
        content: Text(
          '"${entity.name}" becomes a confirmed alias of ${target.name}. '
          'All aliases and linked documents move to ${target.name}; '
          '${entity.name} disappears from the list.\n\n'
          'This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Merge'),
          ),
        ],
      ),
    );
    if (confirmed == true) action(entity, target);
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(22),
    child: ListView(
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                entity.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w700,
                  color: VaultColors.ink,
                ),
              ),
            ),
            _KindBadge(entity: entity),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          entity.owner
              ? 'Owner · ${entity.documents} linked documents'
              : '${entity.documents} linked documents',
          style: const TextStyle(color: VaultColors.dim),
        ),
        // WO11 A1: owner toggle — person entities only, and only once
        // confirmed (you cannot be the owner before you exist).
        if (entity.kind == EntityKind.person &&
            entity.confirmed &&
            onSetOwner != null) ...[
          const SizedBox(height: 22),
          Text(
            'Owner',
            style: const TextStyle(
              fontWeight: FontWeight.w700,
              color: VaultColors.ink,
            ),
          ),
          const SizedBox(height: 7),
          Text(
            entity.owner
                ? '${entity.name} is the owner of this vault.'
                : 'Exactly one person is the owner — the self this vault is for.',
            style: const TextStyle(color: VaultColors.dim, height: 1.4),
          ),
          const SizedBox(height: 9),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              onPressed: () => _confirmOwner(context),
              icon: Icon(
                entity.owner ? Icons.star : Icons.star_outline,
                size: 16,
              ),
              label: Text(entity.owner ? 'Unset owner' : 'Make owner'),
            ),
          ),
        ],
        const SizedBox(height: 22),
        Text(
          entity.kind == EntityKind.person
              ? 'Aliases'
              : entity.kind == EntityKind.account
              ? 'Account reference'
              : 'Organisation identity',
          style: const TextStyle(
            fontWeight: FontWeight.w700,
            color: VaultColors.ink,
          ),
        ),
        const SizedBox(height: 7),
        const Text(
          'Aliases, evidence and safe actions appear here.',
          style: TextStyle(color: VaultColors.dim),
        ),
        // WO11 A3: cross-kind collisions. Labelled "Conflicts" — never
        // "match" or "possible duplicate", because a merge is not possible.
        if (entity.conflicts.isNotEmpty) ...[
          const SizedBox(height: 22),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            childrenPadding: EdgeInsets.zero,
            initiallyExpanded: true,
            title: const Text(
              'Conflicts',
              style: TextStyle(
                fontWeight: FontWeight.w700,
                color: VaultColors.ink,
              ),
            ),
            children: [
              for (final conflict in entity.conflicts)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      border: Border.all(color: VaultColors.line),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Same ${conflict.identifierType} on ${_indefinite(entity.kind.label)} and ${_indefinite(conflict.otherKind.label)}',
                          style: const TextStyle(
                            color: VaultColors.ink,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          '${entity.name} · ${conflict.otherName}',
                          style: const TextStyle(color: VaultColors.ink),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          conflict.identifier,
                          style: const TextStyle(
                            color: VaultColors.accent,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 9),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: OutlinedButton(
                            onPressed: onKeepSeparate == null
                                ? null
                                : () => onKeepSeparate!(entity, conflict),
                            child: const Text('Keep separate'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ],
        const SizedBox(height: 22),
        Text(
          'Merge only with ${entity.kind.label}s',
          style: const TextStyle(
            color: VaultColors.ink,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 5),
        const Text(
          'Entities never merge across kinds. Same identifiers remain visible for review.',
          style: TextStyle(color: VaultColors.dim, height: 1.4),
        ),
        // WO11 A2: the merge picker is filtered by kind AND confirmation
        // state; the action itself sits behind a second confirmation.
        if (entity.confirmed &&
            onMerge != null &&
            _mergeCandidates.isNotEmpty) ...[
          const SizedBox(height: 9),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              onPressed: () => _pickMergeTarget(context),
              icon: const Icon(Icons.merge, size: 16),
              label: const Text('Merge with…'),
            ),
          ),
        ],
      ],
    ),
  );
}
