// Document Review — inspect what the vault understood, and correct it.
//
// This replaces a Review tab that only showed the Learning-Mode question queue.
// The queue is still here (it is genuinely useful), but it is now one pane of a
// browser: the list on the left, the document and its metadata on the right.
//
// What this restores from the original app:
//   * a grouped, searchable document list
//   * the document itself, with a hover magnifier for fine print
//   * a Document / Markdown toggle
//   * the extracted metadata, with provenance ("who said so")
//
// Deliberately NOT yet here: inline field editing. The daemon stores
// corrections as field_claims against a TRANSACTION, and this browser is
// document-centric — wiring an editor to the wrong subject would write claims
// that never affect a figure. The metadata is presented read-only with its
// provenance until that path exists, which is honest rather than a text box
// that silently does nothing.
import 'package:flutter/material.dart';

import '../api.dart';
import 'editable_field.dart';
import 'statement_card.dart';
import '../theme.dart';
import 'magnified_document.dart';

class ReviewBrowser extends StatefulWidget {
  final VaultApi api;
  final String? initialDocumentId;

  const ReviewBrowser({super.key, required this.api, this.initialDocumentId});

  @override
  State<ReviewBrowser> createState() => _ReviewBrowserState();
}

class _ReviewBrowserState extends State<ReviewBrowser> {
  List<VaultDoc> _docs = const [];
  VaultDoc? _selected;
  String _query = '';
  bool _loading = true;
  String? _error;

  /// Document vs Markdown for the right-hand pane.
  bool _showMarkdown = false;
  String? _markdown;
  bool _markdownLoading = false;

  /// Page count / render capability for the selected document, and which page
  /// is showing. 1-based, matching the daemon's ?n= parameter.
  PageInfo _pageInfo = PageInfo.none;
  int _page = 1;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant ReviewBrowser oldWidget) {
    super.didUpdateWidget(oldWidget);
    final requested = widget.initialDocumentId;
    if (requested == null || requested == oldWidget.initialDocumentId) return;
    final match = _docs.where((doc) => doc.id == requested).firstOrNull;
    if (match != null && match.id != _selected?.id) _select(match);
  }

  Future<void> _load() async {
    try {
      final docs = await widget.api.documents();
      if (!mounted) return;
      setState(() {
        _docs = docs;
        _loading = false;
        _error = null;
        // A cross-tab jump selects its document; otherwise select newest.
        _selected ??=
            docs
                .where((doc) => doc.id == widget.initialDocumentId)
                .firstOrNull ??
            (docs.isEmpty ? null : docs.first);
        // Same rule as _select(): a non-image document has only a markdown
        // view. Without this the FIRST document (auto-selected, never clicked)
        // would open on the image pane regardless of its format.
        _showMarkdown = _selected != null && !_selected!.hasPageImage;
      });
      final sel = _selected;
      if (sel != null && !sel.hasPageImage && _markdown == null) {
        _loadMarkdown(sel);
      } else if (sel != null && sel.hasPageImage) {
        // The auto-selected document bypasses _select(), so it needs its page
        // count fetched here or a multi-page PDF opens with no pager.
        _loadPageInfo(sel);
      }
    } on VaultAuthException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = VaultError.from(e).message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = VaultError.from(e).message;
      });
    }
  }

  Future<void> _loadMarkdown(VaultDoc doc) async {
    setState(() {
      _markdownLoading = true;
      _markdown = null;
    });
    try {
      final md = await widget.api.documentMarkdown(doc.id);
      if (!mounted) return;
      setState(() {
        _markdown = md;
        _markdownLoading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _markdownLoading = false);
    }
  }

  void _select(VaultDoc doc) {
    setState(() {
      _selected = doc;
      _markdown = null;
      // Reset the pager: page 4 of the previous document is meaningless here,
      // and a stale count would render a pager for a single-page document.
      _pageInfo = PageInfo.none;
      _page = 1;
      // Image documents default to the magnifiable image; everything else has
      // only a markdown view, so land there rather than on a pane that cannot
      // render and a toggle the user must discover.
      _showMarkdown = !doc.hasPageImage;
    });
    if (!doc.hasPageImage) {
      _loadMarkdown(doc);
    } else {
      _loadPageInfo(doc);
    }
  }

  /// Fetch page count for the selected document.
  ///
  /// Guarded against a stale response: selecting B while A's request is in
  /// flight must not apply A's page count to B.
  Future<void> _loadPageInfo(VaultDoc doc) async {
    try {
      final info = await widget.api.pageInfo(doc.id);
      if (!mounted || _selected?.id != doc.id) return;
      setState(() => _pageInfo = info);
    } catch (_) {
      // A failed page count costs the pager, not the preview — the image
      // request is independent and page 1 still renders.
    }
  }

  /// Filtered list. Matches filename, doc type and source so a search for
  /// "swiggy" or "invoice" or "gmail" all work without a mode switch.
  List<VaultDoc> get _visible {
    if (_query.trim().isEmpty) return _docs;
    final q = _query.toLowerCase();
    return _docs
        .where(
          (d) =>
              d.filename.toLowerCase().contains(q) ||
              (d.docType ?? '').toLowerCase().contains(q) ||
              (d.source ?? '').toLowerCase().contains(q),
        )
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(_error!, style: const TextStyle(color: VaultColors.dim)),
        ),
      );
    }

    return Column(
      children: [
        _Header(
          total: _docs.length,
          shown: _visible.length,
          onSearch: (v) => setState(() => _query = v),
        ),
        const Divider(height: 1, color: VaultColors.line),
        Expanded(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                width: 320,
                child: _DocList(
                  docs: _visible,
                  selected: _selected,
                  onSelect: _select,
                ),
              ),
              const VerticalDivider(width: 1, color: VaultColors.line),
              Expanded(
                child: _selected == null
                    ? const Center(
                        child: Text(
                          'No document selected',
                          style: TextStyle(color: VaultColors.faint),
                        ),
                      )
                    : _Detail(
                        api: widget.api,
                        doc: _selected!,
                        showMarkdown: _showMarkdown,
                        markdown: _markdown,
                        markdownLoading: _markdownLoading,
                        pageInfo: _pageInfo,
                        page: _page,
                        onPage: (n) => setState(() => _page = n),
                        onToggle: (wantMarkdown) {
                          setState(() => _showMarkdown = wantMarkdown);
                          if (wantMarkdown && _markdown == null) {
                            _loadMarkdown(_selected!);
                          }
                        },
                        onChanged: _load,
                      ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  final int total;
  final int shown;
  final ValueChanged<String> onSearch;

  const _Header({
    required this.total,
    required this.shown,
    required this.onSearch,
  });

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
    child: Row(
      children: [
        // Flexible, not bare Text: with the "N to teach" button present the
        // fixed title + count + 220px search field overflowed the row at
        // narrow widths (caught by the queue-reachable test, which is the
        // only case that renders all four children at once).
        const Flexible(
          child: Text(
            'Document Review',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w700,
              color: VaultColors.ink,
            ),
          ),
        ),
        const SizedBox(width: 12),
        // State the filter honestly: "12 of 137" beats a bare count when a
        // search is active, because a shrinking list otherwise looks like
        // documents went missing.
        Flexible(
          child: Text(
            shown == total ? '$total documents' : '$shown of $total',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12, color: VaultColors.faint),
          ),
        ),
        const Spacer(),

        SizedBox(
          width: 220,
          child: TextField(
            onChanged: onSearch,
            decoration: const InputDecoration(
              isDense: true,
              hintText: 'Search',
              prefixIcon: Icon(Icons.search, size: 16),
              border: OutlineInputBorder(),
            ),
            style: const TextStyle(fontSize: 13),
          ),
        ),
      ],
    ),
  );
}

class _DocList extends StatelessWidget {
  final List<VaultDoc> docs;
  final VaultDoc? selected;
  final ValueChanged<VaultDoc> onSelect;

  const _DocList({
    required this.docs,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    if (docs.isEmpty) {
      return const Center(
        child: Text(
          'Nothing matches',
          style: TextStyle(color: VaultColors.faint, fontSize: 13),
        ),
      );
    }
    return ListView.builder(
      itemCount: docs.length,
      itemBuilder: (context, i) {
        final d = docs[i];
        final isSel = d.id == selected?.id;
        return InkWell(
          onTap: () => onSelect(d),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            color: isSel ? VaultColors.controlSubtle : null,
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        d.filename,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: isSel ? FontWeight.w600 : FontWeight.w400,
                          color: VaultColors.ink,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        [
                          d.receivedAt.split('T').first,
                          if (d.docType != null) d.docType!,
                          if (d.source != null) d.source!,
                        ].join(' · '),
                        style: const TextStyle(
                          fontSize: 11,
                          color: VaultColors.faint,
                        ),
                      ),
                    ],
                  ),
                ),
                // Analysed vs merely stored. The distinction matters: an
                // unanalysed document contributes nothing to any total.
                Tooltip(
                  message: d.analysed ? 'Analysed' : 'Not analysed yet',
                  child: Icon(
                    Icons.circle,
                    size: 8,
                    color: d.analysed
                        ? const Color(0xFF16663C)
                        : VaultColors.lineBright,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// The evidence summary (work order 05 §A.3): what the vault read from this
/// document — invoice number, dates, bill-to, person, and the amount WITH
/// its source currency — each value carrying its provenance badge, and the
/// person/amount/currency correctable in place (document-scope claims).
///
/// This is the card that makes a USD invoice display as USD 597.85: the
/// amount rendered here is `effective.amount_minor` + `effective.currency`
/// straight from the daemon, never a client-side assumption.
class _EvidenceCard extends StatefulWidget {
  final VaultApi api;
  final VaultDoc doc;
  final VoidCallback? onChanged;

  const _EvidenceCard({
    super.key,
    required this.api,
    required this.doc,
    this.onChanged,
  });

  @override
  State<_EvidenceCard> createState() => _EvidenceCardState();
}

class _EvidenceCardState extends State<_EvidenceCard> {
  DocumentDetail? _detail;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(_EvidenceCard old) {
    super.didUpdateWidget(old);
    if (old.doc.id != widget.doc.id) {
      _detail = null;
      _failed = false;
      _load();
    }
  }

  Future<void> _load() async {
    try {
      final d = await widget.api.documentDetail(widget.doc.id);
      if (mounted && widget.doc.id == d.document['id']) {
        setState(() => _detail = d);
      }
    } catch (_) {
      // The summary is an enhancement over the document pane, not a
      // precondition for it — a fetch failure costs the card, not the review.
      if (mounted) setState(() => _failed = true);
    }
  }

  FieldClaim? _claimOf(String field) {
    final c = _detail?.claims[field];
    if (c == null) return null;
    return FieldClaim(
      source: (c['source'] ?? 'ai') as String,
      status: (c['status'] ?? 'proposed') as String,
      value: c['value'] as String?,
      confidence: (c['confidence'] as num?)?.toDouble(),
      at: c['at'] as String?,
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = _detail;
    if (d == null) {
      return _failed
          ? const SizedBox.shrink()
          : const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: LinearProgressIndicator(minHeight: 2),
            );
    }
    if (d.extraction == null) return const SizedBox.shrink();

    final currency = d['currency']?.value;
    final amountMinor = int.tryParse(d['amount_minor']?.value ?? '');
    final people = d.parties.where((p) => p['kind'] == 'person').toList();
    final orgs = d.parties.where((p) => p['kind'] == 'organisation').toList();

    return Container(
      margin: const EdgeInsets.fromLTRB(20, 0, 20, 8),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      decoration: BoxDecoration(
        color: VaultColors.panel,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: VaultColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // The amount, never detached from its currency context (§A.3).
          if (amountMinor != null)
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  money(amountMinor, currency),
                  style: moneyStyle.copyWith(
                    fontSize: 17,
                    color: currency == null
                        ? VaultColors.warn
                        : VaultColors.ink,
                  ),
                ),
                const SizedBox(width: 8),
                if (currency == null)
                  const Flexible(
                    child: Text(
                      'currency uncertain — set it below',
                      style: TextStyle(fontSize: 11, color: VaultColors.warn),
                    ),
                  )
                else
                  _ProvBadge(source: d['currency']!.source),
                const Spacer(),
                for (final t in d.transactions)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: Text(
                      '${t.direction} · ${t.sourceAmount} · linked by ${t.linkedBy ?? "ai"}',
                      style: const TextStyle(
                        fontSize: 10.5,
                        fontFamily: VaultType.mono,
                        color: VaultColors.faint,
                      ),
                    ),
                  ),
              ],
            ),
          if (amountMinor != null) const SizedBox(height: 8),

          // Invoice identity row: number, dates, bill-to.
          Wrap(
            spacing: 18,
            runSpacing: 4,
            children: [
              if (d.referenceIds['invoice_no'] != null)
                _Fact(
                  label: 'invoice',
                  value: '${d.referenceIds['invoice_no']}',
                ),
              if (d['document_date'] != null)
                _Fact(label: 'date', value: d['document_date']!.value),
              if (d['posted_at'] != null)
                _Fact(label: 'due / settled', value: d['posted_at']!.value),
              if (orgs.isNotEmpty)
                _Fact(
                  label: 'bill-to / counterparty',
                  value: orgs.first['display_name'] as String,
                ),
              for (final p in people)
                _Fact(
                  label: 'person (${p['role']})',
                  value: p['display_name'] as String,
                ),
            ],
          ),

          // Itemised bill, when the document prints one (§A.4.5).
          if (d.lineItems.isNotEmpty) ...[
            const SizedBox(height: 8),
            const Divider(height: 1, color: VaultColors.line),
            const SizedBox(height: 6),
            for (final li in d.lineItems)
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '${li['description']}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11.5,
                        color: VaultColors.dim,
                      ),
                    ),
                  ),
                  if (li['amount_minor'] != null)
                    Text(
                      money((li['amount_minor'] as num).toInt(), currency),
                      style: const TextStyle(
                        fontSize: 11.5,
                        fontFamily: VaultType.mono,
                        color: VaultColors.dim,
                      ),
                    ),
                ],
              ),
            if (d.subtotalMinor != null || d.taxMinor != null) ...[
              const SizedBox(height: 4),
              Row(
                children: [
                  const Spacer(),
                  if (d.subtotalMinor != null)
                    Text(
                      'subtotal ${money(d.subtotalMinor!, currency)}   ',
                      style: const TextStyle(
                        fontSize: 10.5,
                        color: VaultColors.faint,
                      ),
                    ),
                  if (d.taxMinor != null)
                    Text(
                      'tax ${money(d.taxMinor!, currency)}',
                      style: const TextStyle(
                        fontSize: 10.5,
                        color: VaultColors.faint,
                      ),
                    ),
                ],
              ),
            ],
          ],

          const SizedBox(height: 6),
          const Divider(height: 1, color: VaultColors.line),
          const SizedBox(height: 4),

          // Correctable fields, document-scope (§Track C). Editing the person
          // relinks THIS document and teaches the identity resolver; it never
          // rewrites the original or its markdown.
          EditableField(
            label: 'person',
            field: 'person',
            subjectType: 'documents',
            subjectId: widget.doc.id,
            api: widget.api,
            value:
                d['person']?.value ??
                (people.isEmpty
                    ? null
                    : people.first['display_name'] as String),
            claim: _claimOf('person'),
            editable: d.editableFields.contains('person'),
            onSaved: (_) {
              _load();
              widget.onChanged?.call();
            },
          ),
          EditableField(
            label: 'currency',
            field: 'currency',
            subjectType: 'documents',
            subjectId: widget.doc.id,
            api: widget.api,
            value: currency,
            claim: _claimOf('currency'),
            editable: d.editableFields.contains('currency'),
            onSaved: (_) {
              _load();
              widget.onChanged?.call();
            },
          ),
          EditableField(
            label: 'amount (minor)',
            field: 'amount_minor',
            subjectType: 'documents',
            subjectId: widget.doc.id,
            api: widget.api,
            numeric: true,
            value: d['amount_minor']?.value,
            claim: _claimOf('amount_minor'),
            editable: d.editableFields.contains('amount_minor'),
            onSaved: (_) {
              _load();
              widget.onChanged?.call();
            },
          ),
        ],
      ),
    );
  }
}

/// One immutable fact in the summary strip: "invoice  INV/2026-27/03".
class _Fact extends StatelessWidget {
  final String label;
  final String value;
  const _Fact({required this.label, required this.value});

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(
        '$label  ',
        style: const TextStyle(
          fontSize: 10.5,
          fontFamily: VaultType.mono,
          color: VaultColors.faint,
        ),
      ),
      Text(
        value,
        style: const TextStyle(fontSize: 11.5, color: VaultColors.ink),
      ),
    ],
  );
}

/// A tiny provenance chip — who said so: ai | rule | user | import.
class _ProvBadge extends StatelessWidget {
  final String source;
  const _ProvBadge({required this.source});

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (source) {
      'user' => (const Color(0xFFEAF6EE), const Color(0xFF16663C)),
      'rule' => (const Color(0xFFEAF2FD), const Color(0xFF1B4F8A)),
      _ => (const Color(0xFFF7F7FA), VaultColors.faint),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(
        source,
        style: TextStyle(
          fontSize: 9,
          fontFamily: VaultType.mono,
          color: fg,
          height: 1.3,
        ),
      ),
    );
  }
}

class _Detail extends StatelessWidget {
  final VaultApi api;
  final VaultDoc doc;
  final bool showMarkdown;
  final String? markdown;
  final bool markdownLoading;
  final PageInfo pageInfo;
  final int page;
  final ValueChanged<int> onPage;
  final ValueChanged<bool> onToggle;

  /// Called after a claim edit so the shell can refetch ledger/people.
  final VoidCallback? onChanged;

  const _Detail({
    required this.api,
    required this.doc,
    required this.showMarkdown,
    required this.markdown,
    required this.markdownLoading,
    required this.pageInfo,
    required this.page,
    required this.onPage,
    required this.onToggle,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    doc.filename,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: VaultColors.ink,
                    ),
                  ),
                  Text(
                    '${doc.receivedAt.split('T').first} · '
                    '${doc.analysed ? 'analysed' : 'awaiting analysis'}',
                    style: const TextStyle(
                      fontSize: 11,
                      color: VaultColors.faint,
                    ),
                  ),
                ],
              ),
            ),
            _Toggle(
              showMarkdown: showMarkdown,
              // A non-image document has exactly one view, so there is
              // nothing to toggle between — the control is omitted rather
              // than shown with a permanently-dead half.
              hasPageImage: doc.hasPageImage,
              markdownAvailable: doc.hasMarkdown,
              onToggle: onToggle,
            ),
          ],
        ),
      ),
      if (doc.docType == 'bank_statement' || doc.docType == 'card_statement')
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
          child: StatementCard(api: api, documentId: doc.id),
        ),
      // The evidence summary: what the vault read, with source currency
      // and provenance (work order 05 §A.3). Keyed by document so
      // switching documents or toggling Document/Markdown never shows a
      // stale document's figures.
      //
      // No flex factor: the card takes only its intrinsic height (capped at
      // 220px by the ConstrainedBox), and the Expanded document pane below
      // gets ALL the remaining space. With a shared flex: 1 the two split
      // the remaining height 50/50, leaving the document pane too small to
      // read — the document must fit to height, the card must not steal
      // that space.
      ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 220),
        child: SingleChildScrollView(
          child: _EvidenceCard(
            key: ValueKey('evidence-${doc.id}'),
            api: api,
            doc: doc,
            onChanged: onChanged,
          ),
        ),
      ),
      Expanded(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
          child: showMarkdown
              ? _MarkdownPane(markdown: markdown, loading: markdownLoading)
              : _DocumentPane(api: api, doc: doc, page: page),
        ),
      ),
      // The pager sits BELOW the document, not above: it is navigation for
      // what you are looking at, and putting it under the image keeps the
      // document top-aligned with the metadata beside it.
      if (!showMarkdown && pageInfo.showPager)
        _Pager(page: page, pages: pageInfo.pages, onPage: onPage)
      else
        const SizedBox(height: 12),
    ],
  );
}

class _Toggle extends StatelessWidget {
  final bool showMarkdown;
  final bool hasPageImage;
  final bool markdownAvailable;
  final ValueChanged<bool> onToggle;

  const _Toggle({
    required this.showMarkdown,
    required this.hasPageImage,
    required this.markdownAvailable,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    // Non-image: markdown is the only view. Label it so the pane is not
    // unexplained, but offer no choice — a two-option control with one dead
    // option invites clicks that cannot do anything.
    if (!hasPageImage) {
      return const Padding(
        padding: EdgeInsets.only(left: 6),
        child: Text(
          'Markdown only',
          style: TextStyle(fontSize: 11, color: VaultColors.faint),
        ),
      );
    }

    return Row(
      children: [
        _Seg(
          label: 'Document',
          selected: !showMarkdown,
          onTap: () => onToggle(false),
        ),
        _Seg(
          label: 'Markdown',
          // Disabled rather than hidden when there is no text: the toggle
          // vanishing as you move between documents is more confusing than a
          // greyed control that explains itself.
          selected: showMarkdown,
          enabled: markdownAvailable,
          onTap: markdownAvailable ? () => onToggle(true) : null,
        ),
      ],
    );
  }
}

class _Seg extends StatelessWidget {
  final String label;
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;

  const _Seg({
    required this.label,
    required this.selected,
    this.enabled = true,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    enabled: enabled,
    label: label,
    child: InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? VaultColors.accent : VaultColors.controlSubtle,
          borderRadius: BorderRadius.circular(6),
        ),
        margin: const EdgeInsets.only(left: 6),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            color: !enabled
                ? VaultColors.faint.withValues(alpha: 0.45)
                : selected
                ? const Color(0xFFFFFFFF)
                : VaultColors.dim,
          ),
        ),
      ),
    ),
  );
}

/// Page navigation for a multi-page document.
///
/// Only rendered when there is more than one page AND the daemon can render
/// pages beyond the first — a pager that cannot page is worse than none.
class _Pager extends StatelessWidget {
  final int page;
  final int pages;
  final ValueChanged<int> onPage;

  const _Pager({required this.page, required this.pages, required this.onPage});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        IconButton(
          // Disabled at the boundary rather than wrapping: silently jumping
          // from page 1 to page 5 reads as a glitch.
          onPressed: page > 1 ? () => onPage(page - 1) : null,
          icon: const Icon(Icons.chevron_left, size: 18),
          tooltip: 'Previous page',
          visualDensity: VisualDensity.compact,
        ),
        // State both numbers: "2 / 5" tells you where you are AND how much
        // is left, which a bare "2" does not.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            '$page / $pages',
            style: const TextStyle(
              fontSize: 12,
              color: VaultColors.dim,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
        ),
        IconButton(
          onPressed: page < pages ? () => onPage(page + 1) : null,
          icon: const Icon(Icons.chevron_right, size: 18),
          tooltip: 'Next page',
          visualDensity: VisualDensity.compact,
        ),
      ],
    ),
  );
}

class _DocumentPane extends StatelessWidget {
  final VaultApi api;
  final VaultDoc doc;
  final int page;

  const _DocumentPane({
    required this.api,
    required this.doc,
    required this.page,
  });

  @override
  Widget build(BuildContext context) {
    // Non-image documents never route here: _select() and _load() send them
    // straight to markdown, and the toggle offers no way back. Assert rather
    // than render a fallback, so a future caller that breaks that invariant
    // fails loudly in tests instead of showing a silently-empty pane.
    assert(
      doc.hasPageImage,
      'the image pane received ${doc.ext} — non-image documents are '
      'markdown-only and must not reach here',
    );

    return Container(
      decoration: BoxDecoration(
        color: VaultColors.controlSubtle40,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: VaultColors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: MagnifiedDocument(
        // A ValueKey on the page number forces a fresh image when paging.
        // Without it Flutter reuses the element and the previous page's decoded
        // bitmap stays on screen — the pager appears to do nothing.
        key: ValueKey('${doc.id}-p$page'),
        // The PAGE endpoint, not the raw file: the daemon rasterises PDFs
        // server-side, so a 67-PDF vault gets the magnifier too. Bearer auth,
        // not a query token — query-string credentials are refused on every
        // route except the SSE stream.
        image: NetworkImage(
          api.documentPageUrl(doc.id, page: page).toString(),
          headers: api.imageHeaders,
        ),
        fallback: const Center(
          child: Text(
            'Could not load this document',
            style: TextStyle(fontSize: 13, color: VaultColors.dim),
          ),
        ),
      ),
    );
  }
}

class _MarkdownPane extends StatelessWidget {
  final String? markdown;
  final bool loading;

  const _MarkdownPane({required this.markdown, required this.loading});

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }
    if (markdown == null || markdown!.isEmpty) {
      return const Center(
        child: Text(
          'Not converted yet',
          style: TextStyle(fontSize: 13, color: VaultColors.faint),
        ),
      );
    }
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: VaultColors.controlSubtle40,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: VaultColors.line),
      ),
      child: SingleChildScrollView(
        child: SelectableText(
          markdown!,
          style: const TextStyle(
            fontSize: 12,
            height: 1.5,
            fontFamily: 'monospace',
            color: VaultColors.ink,
          ),
        ),
      ),
    );
  }
}
