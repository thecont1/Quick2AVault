library;

import 'package:flutter/material.dart';

import '../../theme.dart';
import 'state.dart';

export 'state.dart';

/// Entity desk: kinds are visually explicit and all destructive actions stay
/// scoped to the selected kind.
class EntityDesk extends StatefulWidget {
  final List<EntitySummary> entities;
  final ValueChanged<EntitySummary>? onSelected;
  const EntityDesk({super.key, required this.entities, this.onSelected});
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
            : _EntityDetail(entity: selected);
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

class _EntityDetail extends StatelessWidget {
  final EntitySummary entity;
  const _EntityDetail({required this.entity});
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
      ],
    ),
  );
}
