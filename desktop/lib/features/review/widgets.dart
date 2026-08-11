import 'package:flutter/material.dart';

import '../../theme.dart';
import 'state.dart';

class PartyChoice {
  final String id;
  final String displayName;

  const PartyChoice({required this.id, required this.displayName});
}

class FinancialImpactPanel extends StatelessWidget {
  final DetailDocument document;
  final ValueChanged<ImpactBucket>? onBucketChanged;

  const FinancialImpactPanel({
    super.key,
    required this.document,
    this.onBucketChanged,
  });

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(18),
    decoration: BoxDecoration(
      color: const Color(0xffe6f0ff),
      border: Border.all(color: VaultColors.accent.withValues(alpha: .4)),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.trending_up, size: 18, color: VaultColors.accent),
            const SizedBox(width: 8),
            const Expanded(
              child: Text(
                'Financial impact',
                style: TextStyle(
                  color: VaultColors.ink,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            _Badge(
              document.confirmed ? 'Confirmed' : 'Pending review',
              document.confirmed ? VaultColors.ok : VaultColors.warn,
            ),
          ],
        ),
        const SizedBox(height: 12),
        Text(
          document.impactWording,
          style: const TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w700,
            color: VaultColors.ink,
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            if (document.confidence case final confidence?)
              _Badge('${(confidence * 100).round()}%', VaultColors.ok),
            Tooltip(
              message:
                  document.advisoryHint ??
                  'Not a booked entry or accounting advice.',
              child: const Text(
                'Advisory hint ⓘ',
                style: TextStyle(color: VaultColors.dim, fontSize: 11),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) {
            final picker = DropdownButtonHideUnderline(
              child: DropdownButton<ImpactBucket>(
                isExpanded: true,
                value: document.bucket,
                onChanged: onBucketChanged == null
                    ? null
                    : (value) {
                        if (value != null) onBucketChanged!(value);
                      },
                items: [
                  for (final bucket in ImpactBucket.values)
                    DropdownMenuItem(
                      value: bucket,
                      child: Text(
                        bucket.label,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
              ),
            );
            if (constraints.maxWidth < 380) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Set bucket',
                    style: TextStyle(color: VaultColors.dim),
                  ),
                  const SizedBox(height: 6),
                  picker,
                ],
              );
            }
            return Row(
              children: [
                const Text(
                  'Set bucket',
                  style: TextStyle(color: VaultColors.dim),
                ),
                const SizedBox(width: 12),
                Expanded(child: picker),
              ],
            );
          },
        ),
      ],
    ),
  );
}

class ProvenanceFieldRow extends StatelessWidget {
  final DetailField field;
  final ValueChanged<String?>? onChanged;

  const ProvenanceFieldRow({super.key, required this.field, this.onChanged});

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: VaultColors.panel,
      border: Border.all(color: VaultColors.line),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                field.label,
                style: const TextStyle(
                  color: VaultColors.ink,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            Flexible(
              child: Wrap(
                spacing: 6,
                runSpacing: 4,
                alignment: WrapAlignment.end,
                children: [
                  _Badge(
                    field.provenance.label,
                    field.provenance == ClaimProvenance.aiDerived
                        ? VaultColors.dim
                        : field.provenance == ClaimProvenance.userConfirmed
                        ? VaultColors.accent
                        : VaultColors.ok,
                  ),
                  if (field.confidence case final confidence?)
                    _Badge('${(confidence * 100).round()}%', VaultColors.ok),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 7),
        if (field.choices.isNotEmpty)
          DropdownButtonFormField<String>(
            initialValue: field.choices.contains(field.value)
                ? field.value
                : null,
            isExpanded: true,
            hint: Text(field.value, overflow: TextOverflow.ellipsis),
            items: [
              for (final choice in field.choices)
                DropdownMenuItem(
                  value: choice,
                  child: Text(choice, overflow: TextOverflow.ellipsis),
                ),
            ],
            onChanged: field.editable ? onChanged : null,
          )
        else
          SelectableText(
            field.value.isEmpty ? 'Not set' : field.value,
            style: const TextStyle(color: VaultColors.ink),
          ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          children: [
            TextButton.icon(
              onPressed: field.editable
                  ? () => onChanged?.call(field.value)
                  : null,
              icon: const Icon(Icons.edit_outlined, size: 15),
              label: const Text('Correct'),
            ),
            if (field.why != null ||
                field.provenance == ClaimProvenance.aiDerived)
              Tooltip(
                message:
                    field.why ??
                    'This value came from the document extraction.',
                child: TextButton(onPressed: () {}, child: const Text('Why?')),
              ),
          ],
        ),
      ],
    ),
  );
}

class PartiesSection extends StatelessWidget {
  final List<DetailParty> parties;
  final Map<DocumentPartyRole, List<PartyChoice>> choices;
  final void Function(DocumentPartyRole role, String? value)? onChanged;

  const PartiesSection({
    super.key,
    this.parties = const [],
    this.choices = const {},
    this.onChanged,
  });

  DetailParty? _party(DocumentPartyRole role) {
    for (final party in parties) {
      if (party.role == role) return party;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text(
        'Parties',
        style: TextStyle(fontWeight: FontWeight.w700, color: VaultColors.ink),
      ),
      const SizedBox(height: 8),
      for (final role in DocumentPartyRole.values)
        _PartyRow(
          role: role,
          party: _party(role),
          choices: choices[role] ?? const [],
          onChanged: onChanged == null
              ? null
              : (value) => onChanged!(role, value),
        ),
    ],
  );
}

class _PartyRow extends StatelessWidget {
  final DocumentPartyRole role;
  final DetailParty? party;
  final List<PartyChoice> choices;
  final ValueChanged<String?>? onChanged;

  const _PartyRow({
    required this.role,
    required this.party,
    required this.choices,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final currentId = party?.entityId;
    final knownChoices = <String, PartyChoice>{
      if (currentId != null)
        currentId: PartyChoice(
          id: currentId,
          displayName: party?.displayName ?? currentId,
        ),
      for (final choice in choices) choice.id: choice,
    }.values.toList();
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        border: Border.all(color: VaultColors.line),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            flex: 2,
            child: Text(
              role.label,
              style: const TextStyle(color: VaultColors.dim),
            ),
          ),
          Expanded(
            flex: 3,
            child: knownChoices.isEmpty
                ? TextButton(
                    onPressed: onChanged == null
                        ? null
                        : () => onChanged!(null),
                    child: const Text('Choose from list'),
                  )
                : DropdownButtonHideUnderline(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: currentId,
                      hint: const Text('Choose from list'),
                      onChanged: onChanged,
                      items: [
                        for (final choice in knownChoices)
                          DropdownMenuItem(
                            value: choice.id,
                            child: Text(
                              choice.displayName,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                    ),
                  ),
          ),
          if (party?.kind case final kind?)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: _Badge(kind, VaultColors.dim),
            ),
        ],
      ),
    );
  }
}

class DomainPanel extends StatelessWidget {
  final DetailDocument document;

  const DomainPanel({super.key, required this.document});

  @override
  Widget build(BuildContext context) {
    if (document.type != DetailType.taxInvoice &&
        document.type != DetailType.contractNote) {
      return const SizedBox.shrink();
    }
    final invoice = document.type == DetailType.taxInvoice;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          invoice ? 'Line items' : 'Contract note',
          style: const TextStyle(
            fontWeight: FontWeight.w700,
            color: VaultColors.ink,
          ),
        ),
        const SizedBox(height: 8),
        if (!invoice)
          const Text(
            'Broker · Client · Trade date · Contract Note No.',
            style: TextStyle(color: VaultColors.dim),
          ),
        if (document.lines.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Text(
              'No type-specific rows were extracted.',
              style: TextStyle(color: VaultColors.dim),
            ),
          ),
        for (final line in document.lines)
          Container(
            margin: const EdgeInsets.only(top: 6),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: VaultColors.controlSubtle,
              borderRadius: BorderRadius.circular(9),
            ),
            child: Wrap(
              spacing: 12,
              runSpacing: 5,
              children: [
                if (line.direction != null)
                  _Badge(line.direction!, VaultColors.accent),
                Text(
                  line.description,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    color: VaultColors.ink,
                  ),
                ),
                Text(
                  '${invoice ? 'HSN/SAC' : 'ISIN'} ${line.code}',
                  style: const TextStyle(color: VaultColors.dim),
                ),
                Text(
                  '${line.quantity} @ ${line.rate}',
                  style: const TextStyle(color: VaultColors.dim),
                ),
                Text(
                  line.amount,
                  style: const TextStyle(color: VaultColors.ink),
                ),
              ],
            ),
          ),
        const SizedBox(height: 8),
        Text(
          document.advisoryHint ??
              (invoice
                  ? 'ⓘ Recognized as a tax invoice; not accounting advice.'
                  : 'ⓘ Recognized as a broker contract note — mapped to investment activity, not a generic expense.'),
          style: const TextStyle(color: VaultColors.dim, fontSize: 11),
        ),
      ],
    );
  }
}

class CurrencyConversionRow extends StatelessWidget {
  final CurrencyConversionDetail conversion;
  final VoidCallback? onCorrect;

  const CurrencyConversionRow({
    super.key,
    required this.conversion,
    this.onCorrect,
  });

  @override
  Widget build(BuildContext context) {
    final converted = conversion.convertedAmount;
    final text = converted == null
        ? '${conversion.originalAmount} ${conversion.originalCurrency} → conversion pending'
        : '${conversion.originalAmount} ${conversion.originalCurrency} → $converted ${conversion.homeCurrency}';
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: VaultColors.panel,
        border: Border.all(color: VaultColors.line),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Currency conversion',
                  style: TextStyle(
                    color: VaultColors.ink,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              _Badge(
                conversion.stale ? 'Cached fallback' : 'Fresh rate',
                conversion.stale ? VaultColors.warn : VaultColors.ok,
              ),
            ],
          ),
          const SizedBox(height: 7),
          Text(text, style: const TextStyle(color: VaultColors.ink)),
          if (conversion.rate != null || conversion.rateDate != null)
            Text(
              [
                if (conversion.rate != null) 'rate ${conversion.rate}',
                if (conversion.rateDate != null) conversion.rateDate!,
                if (conversion.rateSource != null) conversion.rateSource!,
              ].join(' · '),
              style: const TextStyle(color: VaultColors.dim, fontSize: 11),
            ),
          TextButton.icon(
            onPressed: onCorrect,
            icon: const Icon(Icons.edit_outlined, size: 15),
            label: const Text('Correct'),
          ),
        ],
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  final String text;
  final Color color;

  const _Badge(this.text, this.color);

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: vaultPill(
      fill: color.withValues(alpha: .11),
      border: color.withValues(alpha: .2),
    ),
    child: Text(
      text,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700),
    ),
  );
}
