library;

import 'package:flutter/material.dart';
import '../../theme.dart';
import '../people/state.dart';
import 'state.dart';
export '../people/state.dart';
export 'state.dart';

class IntakeView extends StatefulWidget {
  final List<IntakeItem> items;
  final ValueChanged<IntakeItem>? onOpenDocument;
  const IntakeView({super.key, required this.items, this.onOpenDocument});
  @override
  State<IntakeView> createState() => _IntakeViewState();
}

class _IntakeViewState extends State<IntakeView> {
  String? _selected;
  @override
  Widget build(BuildContext context) {
    final ordered = [...widget.items]..sort((a, b) => b.date.compareTo(a.date));
    final selected = ordered.where((e) => e.id == _selected).firstOrNull;
    return LayoutBuilder(
      builder: (context, c) {
        final list = _IntakeList(
          items: ordered,
          selected: _selected,
          onSelect: (item) => setState(() => _selected = item.id),
        );
        final preview = selected == null
            ? const _IntakePreviewEmpty()
            : _IntakePreview(
                item: selected,
                onOpen: () => widget.onOpenDocument?.call(selected),
              );
        return c.maxWidth < 650
            ? Column(
                children: [
                  Expanded(child: list),
                  if (selected != null) preview,
                ],
              )
            : Row(
                children: [
                  Expanded(flex: 3, child: list),
                  const VerticalDivider(width: 1),
                  SizedBox(width: 300, child: preview),
                ],
              );
      },
    );
  }
}

class _IntakeList extends StatelessWidget {
  final List<IntakeItem> items;
  final String? selected;
  final ValueChanged<IntakeItem> onSelect;
  const _IntakeList({
    required this.items,
    required this.selected,
    required this.onSelect,
  });
  @override
  Widget build(BuildContext context) {
    final counts = <PipelineState, int>{};
    for (final item in items) {
      counts[item.state] = (counts[item.state] ?? 0) + 1;
    }
    final groups = <String, List<IntakeItem>>{};
    for (final item in items) {
      groups.putIfAbsent(item.entity, () => []).add(item);
    }
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Text(
          '${items.length} arrival${items.length == 1 ? '' : 's'}',
          style: const TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w700,
            color: VaultColors.ink,
          ),
        ),
        const SizedBox(height: 9),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: counts.entries
              .map((entry) => _StateChip(state: entry.key, count: entry.value))
              .toList(),
        ),
        const SizedBox(height: 18),
        if (items.isEmpty)
          const Center(
            child: Padding(
              padding: EdgeInsets.all(30),
              child: Text(
                'No live arrivals',
                style: TextStyle(color: VaultColors.dim),
              ),
            ),
          ),
        for (final group in groups.entries) ...[
          Text(
            group.key.toUpperCase(),
            style: const TextStyle(
              fontSize: 10,
              letterSpacing: 1,
              fontWeight: FontWeight.w700,
              color: VaultColors.dim,
            ),
          ),
          const SizedBox(height: 6),
          for (final item in group.value)
            _IntakeRow(
              item: item,
              selected: item.id == selected,
              onTap: () => onSelect(item),
            ),
          const SizedBox(height: 14),
        ],
      ],
    );
  }
}

class _StateChip extends StatelessWidget {
  final PipelineState state;
  final int count;
  const _StateChip({required this.state, required this.count});
  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      PipelineState.complete => VaultColors.ok,
      PipelineState.failed || PipelineState.passwordNeeded => VaultColors.out,
      PipelineState.duplicate || PipelineState.irrelevant => VaultColors.warn,
      _ => VaultColors.accent,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: vaultPill(
        fill: color.withValues(alpha: .1),
        border: color.withValues(alpha: .35),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            state.label,
            style: TextStyle(
              color: color,
              fontSize: 10,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(width: 4),
          Text(
            '$count',
            style: TextStyle(
              color: color,
              fontSize: 10,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _IntakeRow extends StatelessWidget {
  final IntakeItem item;
  final bool selected;
  final VoidCallback onTap;
  const _IntakeRow({
    required this.item,
    required this.selected,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: selected ? VaultColors.controlSubtle : null,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: VaultColors.line),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.description_outlined, color: VaultColors.dim, size: 18),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.filename,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: VaultColors.ink,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  '${item.source} · ${item.entityKind.label}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: VaultColors.dim, fontSize: 11),
                ),
                if (item.reason != null)
                  Text(
                    item.reason!,
                    style: const TextStyle(
                      color: VaultColors.out,
                      fontSize: 11,
                    ),
                  ),
              ],
            ),
          ),
          _StateChip(state: item.state, count: 1),
        ],
      ),
    ),
  );
}

class _IntakePreviewEmpty extends StatelessWidget {
  const _IntakePreviewEmpty();
  @override
  Widget build(BuildContext context) => const Center(
    child: Text('Select an arrival', style: TextStyle(color: VaultColors.dim)),
  );
}

class _IntakePreview extends StatelessWidget {
  final IntakeItem item;
  final VoidCallback onOpen;
  const _IntakePreview({required this.item, required this.onOpen});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(18),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          item.filename,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontWeight: FontWeight.w700,
            color: VaultColors.ink,
          ),
        ),
        const SizedBox(height: 10),
        Text(item.source, style: const TextStyle(color: VaultColors.dim)),
        const SizedBox(height: 14),
        TextButton.icon(
          onPressed: onOpen,
          icon: const Icon(Icons.open_in_new, size: 16),
          label: const Text('Open in Review'),
        ),
      ],
    ),
  );
}
