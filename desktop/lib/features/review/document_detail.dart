library;

import 'package:flutter/material.dart';

import '../../theme.dart';
import 'state.dart';
import 'widgets.dart';

export 'state.dart';

class DocumentDetailPanel extends StatefulWidget {
  final DetailDocument document;
  final VoidCallback? onBack;
  final DetailFieldChanged? onFieldChanged;
  final DetailPartyChanged? onPartyChanged;
  final DocumentActionCallback? onAction;
  final VoidCallback? onTeachNow;

  const DocumentDetailPanel({
    super.key,
    required this.document,
    this.onBack,
    this.onFieldChanged,
    this.onPartyChanged,
    this.onAction,
    this.onTeachNow,
  });

  @override
  State<DocumentDetailPanel> createState() => _DocumentDetailPanelState();
}

class _DocumentDetailPanelState extends State<DocumentDetailPanel> {
  bool _markdown = false;
  late ImpactBucket _bucket;

  @override
  void initState() {
    super.initState();
    _bucket = widget.document.bucket;
  }

  @override
  void didUpdateWidget(covariant DocumentDetailPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.document.id != widget.document.id ||
        oldWidget.document.bucket != widget.document.bucket) {
      _bucket = widget.document.bucket;
      _markdown = false;
    }
  }

  DetailDocument get _visibleDocument => DetailDocument(
    id: widget.document.id,
    filename: widget.document.filename,
    amount: widget.document.amount,
    type: widget.document.type,
    bucket: _bucket,
    confirmed: widget.document.confirmed,
    confidence: widget.document.confidence,
    advisoryHint: widget.document.advisoryHint,
    markdown: widget.document.markdown,
    lines: widget.document.lines,
    fields: widget.document.fields,
    parties: widget.document.parties,
    currencyConversion: widget.document.currencyConversion,
    auditCount: widget.document.auditCount,
    auditEntries: widget.document.auditEntries,
    identityReasoning: widget.document.identityReasoning,
  );

  Future<void> _fieldChanged(String field, Object? value) async {
    await widget.onFieldChanged?.call(widget.document.id, field, value);
  }

  Future<void> _action(DocumentManageAction action) async {
    await widget.onAction?.call(widget.document.id, action);
  }

  @override
  Widget build(BuildContext context) {
    final document = _visibleDocument;
    final fields = document.fields.isNotEmpty
        ? document.fields
        : <DetailField>[
            const DetailField(
              id: 'counterparty',
              label: 'Counterparty',
              value: 'Choose from list',
              provenance: ClaimProvenance.userConfirmed,
              choices: ['Choose from list'],
            ),
            DetailField(
              id: 'documentType',
              label: 'Document type',
              value: document.type.apiValue.replaceAll('_', ' '),
              choices: DetailType.values
                  .map((type) => type.apiValue.replaceAll('_', ' '))
                  .toList(),
            ),
            DetailField(
              id: 'amount',
              label: 'Amount',
              value: document.amount,
              editable: false,
            ),
          ];

    return ListView(
      key: ValueKey('document-detail-${document.id}'),
      padding: const EdgeInsets.all(20),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Editing ${document.filename}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: VaultColors.dim),
              ),
            ),
            if (widget.onBack != null)
              TextButton(
                onPressed: widget.onBack,
                child: const Text('Back to browse'),
              ),
          ],
        ),
        const SizedBox(height: 10),
        _DocTabs(
          markdown: _markdown,
          onChanged: (value) => setState(() => _markdown = value),
        ),
        const SizedBox(height: 14),
        if (_markdown)
          _MarkdownPreview(markdown: document.markdown)
        else
          _DocumentPreview(filename: document.filename),
        const SizedBox(height: 20),
        FinancialImpactPanel(
          document: document,
          onBucketChanged: (bucket) {
            setState(() => _bucket = bucket);
            _fieldChanged('financialImpact', bucket.apiValue);
          },
        ),
        const SizedBox(height: 20),
        DomainPanel(document: document),
        if (document.currencyConversion case final conversion?) ...[
          const SizedBox(height: 20),
          CurrencyConversionRow(
            conversion: conversion,
            onCorrect: () =>
                _fieldChanged('currencyConversion', conversion.rate),
          ),
        ],
        const SizedBox(height: 22),
        Row(
          children: [
            const Expanded(
              child: Text(
                'Fields & evidence',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: VaultColors.ink,
                ),
              ),
            ),
            Text(
              document.confirmed ? 'All reviewed' : 'Needs review',
              style: TextStyle(
                color: document.confirmed ? VaultColors.ok : VaultColors.warn,
              ),
            ),
          ],
        ),
        const SizedBox(height: 9),
        for (final field in fields)
          ProvenanceFieldRow(
            field: field,
            onChanged: (value) => _fieldChanged(field.id, value),
          ),
        const SizedBox(height: 16),
        PartiesSection(
          parties: document.parties,
          onChanged: widget.onPartyChanged == null
              ? null
              : (role, value) => widget.onPartyChanged!(
                  document.id,
                  role,
                  document.parties
                      .where((party) => party.displayName == value)
                      .firstOrNull
                      ?.entityId,
                ),
        ),
        const SizedBox(height: 18),
        _Disclosure(
          label: 'Identity reasoning',
          content:
              document.identityReasoning ??
              'Tokens, aliases and co-occurrence are available from the daemon.',
        ),
        _Disclosure(
          label: 'Audit trail (${document.auditCount})',
          content: document.auditEntries.isEmpty
              ? 'No recorded changes yet.'
              : document.auditEntries.join('\n'),
        ),
        if (widget.onTeachNow != null) ...[
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: widget.onTeachNow,
            icon: const Icon(Icons.school_outlined),
            label: const Text('Teach it now'),
          ),
        ],
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            TextButton.icon(
              onPressed: () => _action(DocumentManageAction.openOriginal),
              icon: const Icon(Icons.open_in_new, size: 16),
              label: const Text('Open original'),
            ),
            TextButton.icon(
              onPressed: () => _action(DocumentManageAction.openMarkdown),
              icon: const Icon(Icons.description_outlined, size: 16),
              label: const Text('Open Markdown'),
            ),
          ],
        ),
        const Divider(height: 30),
        const Text(
          'Manage this document',
          style: TextStyle(color: VaultColors.dim, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton(
              onPressed: () => _action(DocumentManageAction.reprocess),
              child: const Text('Reprocess'),
            ),
            OutlinedButton(
              onPressed: () => _action(DocumentManageAction.removeFromActive),
              child: const Text('Remove from active'),
            ),
            TextButton(
              onPressed: () => _confirmDelete(context),
              child: const Text('Delete permanently'),
            ),
          ],
        ),
        const SizedBox(height: 6),
        const Text(
          'Removing from active keeps the original file safe — you can restore or reprocess it anytime.',
          style: TextStyle(color: VaultColors.dim, fontSize: 11, height: 1.35),
        ),
      ],
    );
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete permanently?'),
        content: const Text(
          'This destructive action is separate from Remove from active and cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete permanently'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await _action(DocumentManageAction.deletePermanently);
    }
  }
}

class _DocTabs extends StatelessWidget {
  final bool markdown;
  final ValueChanged<bool> onChanged;

  const _DocTabs({required this.markdown, required this.onChanged});

  @override
  Widget build(BuildContext context) => SegmentedButton<bool>(
    segments: const [
      ButtonSegment(value: false, label: Text('Document')),
      ButtonSegment(value: true, label: Text('Markdown')),
    ],
    selected: {markdown},
    onSelectionChanged: (values) => onChanged(values.first),
  );
}

class _DocumentPreview extends StatelessWidget {
  final String filename;

  const _DocumentPreview({required this.filename});

  @override
  Widget build(BuildContext context) => Container(
    height: 180,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: VaultColors.controlSubtle,
      border: Border.all(color: VaultColors.line),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Text(
      'Document preview\n$filename',
      textAlign: TextAlign.center,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(color: VaultColors.dim),
    ),
  );
}

class _MarkdownPreview extends StatelessWidget {
  final String? markdown;

  const _MarkdownPreview({this.markdown});

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 180),
    width: double.infinity,
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: VaultColors.controlSubtle,
      borderRadius: BorderRadius.circular(10),
    ),
    child: SelectableText(
      markdown?.isNotEmpty == true
          ? markdown!
          : 'Markdown is not available for this document.',
      style: const TextStyle(color: VaultColors.dim),
    ),
  );
}

class _Disclosure extends StatefulWidget {
  final String label;
  final String content;

  const _Disclosure({required this.label, required this.content});

  @override
  State<_Disclosure> createState() => _DisclosureState();
}

class _DisclosureState extends State<_Disclosure> {
  bool _open = false;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(
          widget.label,
          style: const TextStyle(
            color: VaultColors.ink,
            fontWeight: FontWeight.w600,
          ),
        ),
        trailing: Icon(_open ? Icons.expand_less : Icons.expand_more),
        onTap: () => setState(() => _open = !_open),
      ),
      if (_open)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Align(
            alignment: Alignment.centerLeft,
            child: SelectableText(
              widget.content,
              style: const TextStyle(color: VaultColors.dim),
            ),
          ),
        ),
    ],
  );
}
