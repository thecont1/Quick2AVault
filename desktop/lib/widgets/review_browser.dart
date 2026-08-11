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
import '../theme.dart';
import 'magnified_document.dart';
import '../features/review/document_detail.dart';
import '../features/review/widgets.dart';
import '../features/adapters.dart';
import '../features/people/state.dart' as feature_people;

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

/// The right-hand document surface: the locked Glaze detail/fields layout
/// (WO09/WO10 P4.5, §1.10) composed over the REAL rasterised preview.
///
/// This mounts [DocumentDetailPanel] — the canonical Glaze component with the
/// financial-impact panel, per-field provenance rows, parties, domain panels,
/// identity-reasoning and audit-trail disclosures, and the manage footer — and
/// feeds it live data via [VaultApiDesktopFeatures.featureDocumentDetail]. The
/// panel's placeholder preview is replaced with the existing magnifiable page
/// image / markdown pane through [DocumentDetailPanel.previewBuilder], so the
/// real document is still readable while the Glaze metadata composes below it.
class _Detail extends StatefulWidget {
  final VaultApi api;
  final VaultDoc doc;
  final bool showMarkdown;
  final String? markdown;
  final bool markdownLoading;
  final PageInfo pageInfo;
  final int page;
  final ValueChanged<int> onPage;
  final ValueChanged<bool> onToggle;

  /// Called after a claim edit / lifecycle action so the shell can refetch
  /// ledger/people and (for remove/delete) drop the now-hidden document.
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
  State<_Detail> createState() => _DetailState();
}

class _DetailState extends State<_Detail> {
  Future<DetailDocument>? _detail;
  late Future<List<feature_people.EntitySummary>?> _entities;

  @override
  void initState() {
    super.initState();
    _detail = widget.api.featureDocumentDetail(widget.doc);
    _entities = widget.api.featureEntities().catchError((_) => <feature_people.EntitySummary>[]);
  }

  @override
  void didUpdateWidget(_Detail old) {
    super.didUpdateWidget(old);
    // Reload the Glaze detail when the selected document changes. The preview
    // panes react to showMarkdown/page directly, so those do NOT trigger a
    // refetch — only a new document id does.
    if (old.doc.id != widget.doc.id) {
      _detail = widget.api.featureDocumentDetail(widget.doc);
    }
  }

  Future<void> _reload() async {
    setState(() {
      _detail = widget.api.featureDocumentDetail(widget.doc);
    });
    widget.onChanged?.call();
  }

  /// The real preview injected into the Glaze panel: the magnifiable page image
  /// or the markdown pane, plus the pager, exactly as the standalone browser
  /// rendered them. Honours the shell's Document/Markdown toggle.
  Widget _preview(BuildContext context, bool markdown) {
    final wantMarkdown = markdown || !widget.doc.hasPageImage;
    // Keep the shell's toggle state in sync with the panel's internal tab so a
    // markdown fetch is triggered when the user switches inside the panel.
    if (wantMarkdown != widget.showMarkdown) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onToggle(wantMarkdown);
      });
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 320,
          child: wantMarkdown
              ? _MarkdownPane(
                  markdown: widget.markdown,
                  loading: widget.markdownLoading,
                )
              : _DocumentPane(
                  api: widget.api,
                  doc: widget.doc,
                  page: widget.page,
                ),
        ),
        if (!wantMarkdown && widget.pageInfo.showPager)
          _Pager(
            page: widget.page,
            pages: widget.pageInfo.pages,
            onPage: widget.onPage,
          ),
      ],
    );
  }

  Future<void> _fieldChanged(String field, Object? value) async {
    try {
      await widget.api.writeClaim(
        subjectType: 'documents',
        subjectId: widget.doc.id,
        field: field,
        value: value,
      );
      await _reload();
    } on ClaimRefusedException catch (e) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _partyChanged(DocumentPartyRole role, String? entityId) async {
    if (entityId == null) return;
    try {
      await widget.api.setDocumentParty(
        documentId: widget.doc.id,
        role: role.apiValue,
        entityId: entityId,
      );
      await _reload();
    } on ClaimRefusedException catch (e) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _action(DocumentManageAction action) async {
    try {
      switch (action) {
        case DocumentManageAction.openOriginal:
          // The daemon serves the original bytes; opening externally is a future
          // platform-channel concern. Surface the resolvable URL for now so the
          // action is honest rather than silent.
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(
                  'Original: ${widget.api.documentFileUrl(widget.doc.id)}',
                ),
              ),
            );
          }
        case DocumentManageAction.openMarkdown:
          widget.onToggle(true);
        case DocumentManageAction.reprocess:
          await widget.api.reprocessDocument(widget.doc.id);
          await _reload();
        case DocumentManageAction.removeFromActive:
          await widget.api.removeFromActive(widget.doc.id);
          widget.onChanged?.call();
        case DocumentManageAction.deletePermanently:
          await widget.api.deleteDocument(widget.doc.id);
          widget.onChanged?.call();
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<DetailDocument>(
    future: _detail,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Center(child: CircularProgressIndicator.adaptive());
      }
      if (snapshot.hasError || !snapshot.hasData) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              'Could not load this document’s details.',
              style: const TextStyle(color: VaultColors.dim),
            ),
          ),
        );
      }
      return FutureBuilder<List<feature_people.EntitySummary>?>(
        future: _entities,
        builder: (context, entSnapshot) {
          final roleCandidates = <DocumentPartyRole, List<PartyChoice>>{};
          if (entSnapshot.hasData && entSnapshot.data != null) {
            final all = entSnapshot.data!
                .map((e) => PartyChoice(id: e.id, displayName: e.name))
                .toList();
            for (final role in DocumentPartyRole.values) {
              roleCandidates[role] = all;
            }
          }
          return DocumentDetailPanel(
            key: ValueKey('glaze-detail-${widget.doc.id}'),
            document: snapshot.data!,
            documentAvailable: widget.doc.hasPageImage,
            markdownAvailable: widget.doc.hasMarkdown,
            initialMarkdown: widget.showMarkdown,
            previewBuilder: _preview,
            roleCandidates: roleCandidates.isEmpty ? null : roleCandidates,
            onFieldChanged: (_, field, value) => _fieldChanged(field, value),
            onPartyChanged: (_, role, entityId) => _partyChanged(role, entityId),
            onAction: (_, action) => _action(action),
          );
        },
      );
    },
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
