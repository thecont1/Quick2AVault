import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Vault search (work order 03 §P1).
///
/// Lexical FTS5 search over filename, markdown and the flattened extraction.
/// Results jump to the evidence card for the document's transaction.
///
/// The daemon wraps matched terms in « » rather than HTML, so highlighting is
/// a pure string parse here — no markup parser, no escaping bugs, and a
/// snippet is safe to render verbatim even when the document contains angle
/// brackets or asterisks.
class SearchBox extends StatefulWidget {
  final VaultApi api;

  /// Called with the transaction id when a result is chosen. Null for an
  /// orphan document — the caller decides whether to open the document
  /// browser instead of the ledger.
  final void Function(SearchHit hit) onOpen;

  const SearchBox({super.key, required this.api, required this.onOpen});

  @override
  State<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<SearchBox> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  Timer? _debounce;

  List<SearchHit> _hits = const [];
  bool _loading = false;
  String? _error;
  bool _open = false;

  /// Guards against an older, slower query overwriting a newer one's results.
  int _seq = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onChanged(String q) {
    _debounce?.cancel();
    if (q.trim().isEmpty) {
      setState(() {
        _hits = const [];
        _open = false;
        _error = null;
      });
      return;
    }
    // 220ms: long enough that typing "swiggy" is one query rather than six,
    // short enough to feel immediate on a local daemon.
    _debounce = Timer(const Duration(milliseconds: 220), () => _run(q));
  }

  Future<void> _run(String q) async {
    final mine = ++_seq;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final hits = await widget.api.search(q, limit: 20);
      if (!mounted || mine != _seq) return;
      setState(() {
        _hits = hits;
        _loading = false;
        _open = true;
      });
    } catch (e) {
      if (!mounted || mine != _seq) return;
      setState(() {
        _loading = false;
        _error = '$e';
        _open = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          height: 34,
          decoration: BoxDecoration(
            color: VaultColors.controlSubtle,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: VaultColors.line),
          ),
          child: Row(children: [
            const SizedBox(width: 9),
            const Icon(Icons.search, size: 15, color: VaultColors.faint),
            const SizedBox(width: 6),
            Expanded(
              child: TextField(
                controller: _controller,
                focusNode: _focus,
                onChanged: _onChanged,
                onSubmitted: _run,
                style: const TextStyle(fontSize: 12.5, color: VaultColors.ink),
                decoration: const InputDecoration(
                  isDense: true,
                  border: InputBorder.none,
                  hintText: 'Search documents — vendor, amount, reference…',
                  hintStyle:
                      TextStyle(fontSize: 12.5, color: VaultColors.faint),
                ),
              ),
            ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.only(right: 9),
                child: SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 1.6),
                ),
              )
            else if (_controller.text.isNotEmpty)
              IconButton(
                icon: const Icon(Icons.close, size: 14),
                color: VaultColors.faint,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                onPressed: () {
                  _controller.clear();
                  setState(() {
                    _hits = const [];
                    _open = false;
                  });
                },
              ),
          ]),
        ),
        if (_open) ...[
          const SizedBox(height: 6),
          _results(),
        ],
      ],
    );
  }

  Widget _results() {
    if (_error != null) {
      return _panel(Text('Search failed · $_error',
          style: const TextStyle(fontSize: 11.5, color: VaultColors.faint)));
    }
    if (_hits.isEmpty) {
      return _panel(const Text('No documents match.',
          style: TextStyle(fontSize: 11.5, color: VaultColors.faint)));
    }
    return _panel(
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final h in _hits) _resultRow(h),
        ],
      ),
    );
  }

  Widget _panel(Widget child) => Container(
        constraints: const BoxConstraints(maxHeight: 340),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: VaultColors.panel,
          border: Border.all(color: VaultColors.line),
          borderRadius: BorderRadius.circular(8),
        ),
        child: SingleChildScrollView(child: child),
      );

  Widget _resultRow(SearchHit h) {
    return InkWell(
      onTap: () {
        setState(() => _open = false);
        _focus.unfocus();
        widget.onOpen(h);
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text(
                h.filename,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontSize: 12, color: VaultColors.ink, height: 1.25),
              ),
            ),
            if (h.amountMinor != null) ...[
              const SizedBox(width: 8),
              Text(
                rupees(h.amountMinor!),
                style: const TextStyle(
                  fontSize: 11.5,
                  fontFamily: VaultType.mono,
                  color: VaultColors.dim,
                ),
              ),
            ],
          ]),
          const SizedBox(height: 3),
          _snippet(h.snippet),
          const SizedBox(height: 3),
          Text(
            [
              if (h.docType != null) h.docType!.replaceAll('_', ' '),
              if (h.occurredAt != null) h.occurredAt!,
              if (h.transactionId == null) 'unlinked',
            ].join(' · '),
            style: const TextStyle(
                fontSize: 10, fontFamily: VaultType.mono, color: VaultColors.faint),
          ),
        ]),
      ),
    );
  }

  /// Render « » delimited matches in bold. Splitting on the delimiters keeps
  /// this a pure text operation — the snippet never becomes markup, so a
  /// document containing < or & renders as itself.
  Widget _snippet(String raw) {
    if (raw.isEmpty) return const SizedBox.shrink();
    final spans = <TextSpan>[];
    var rest = raw;
    while (true) {
      final open = rest.indexOf('«');
      if (open < 0) break;
      final close = rest.indexOf('»', open + 1);
      if (close < 0) break;
      if (open > 0) spans.add(TextSpan(text: rest.substring(0, open)));
      spans.add(TextSpan(
        text: rest.substring(open + 1, close),
        style: const TextStyle(
            fontWeight: FontWeight.w700, color: VaultColors.ink),
      ));
      rest = rest.substring(close + 1);
    }
    if (rest.isNotEmpty) spans.add(TextSpan(text: rest));

    return RichText(
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      text: TextSpan(
        style: const TextStyle(
            fontSize: 11, color: VaultColors.dim, height: 1.35),
        children: spans,
      ),
    );
  }
}
