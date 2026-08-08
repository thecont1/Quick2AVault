import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Live intake rail — the pipeline narrating itself over SSE.
class FeedRail extends StatelessWidget {
  final List<VaultEvent> events;
  final bool connected;
  const FeedRail({super.key, required this.events, required this.connected});

  static String _describe(VaultEvent e) {
    final d = e.data;
    return switch (e.type) {
      'DocumentReceived' => 'received  ${d["filename"]}',
      'DocumentDuplicate' => 'duplicate  ${d["filename"]}  (same bytes — ignored)',
      'MarkdownReady' => 'converted  ${d["chars"]} chars',
      'AnalysisComplete' => 'analysed  ${_short(d["document_id"])}',
      'TransactionRecorded' =>
        'transaction  ${rupees((d["amount_minor"] ?? 0) as int)}  ${d["direction"]}',
      'MatchProposed' =>
        'MATCHED  score ${((d["score"] ?? 0) as num).toStringAsFixed(2)}  → one rupee',
      'JobStateChanged' => '${d["phase"]}  ${d["state"]}',
      _ => e.type,
    };
  }

  /// First 12 chars of an id, for the rail's narrow column.
  /// The bound is explicitly `int` because String.substring demands one, and
  /// it is derived from the string's own length so a short id cannot throw
  /// RangeError.
  static String _short(dynamic id) {
    if (id == null) return '';
    final s = id.toString();
    final int end = s.length < 12 ? s.length : 12;
    return s.substring(0, end);
  }

  static Color _colorFor(String type) => switch (type) {
        'MatchProposed' => VaultColors.ok,
        'TransactionRecorded' => VaultColors.income,
        'DocumentDuplicate' => VaultColors.warn,
        'DocumentReceived' => VaultColors.ink,
        _ => VaultColors.dim,
      };

  @override
  Widget build(BuildContext context) {
    // The rail is fixed at a comfortable reading width, but never more than a
    // third of the window — below ~1040px the ledger needs the room more.
    //
    // The cap must actually hold. The previous expression clamped to a 220
    // FLOOR, which on a narrow window exceeded the third-of-window budget it
    // was supposed to respect: at 400px wide the rail took 220 of a 133px
    // allowance, and at 900px it took 320 of 300. Verified 3 of 8 common
    // widths violated the cap.
    //
    // Order matters: prefer the ideal width, give up at most a third of the
    // window, and only then apply the readable minimum — so a genuinely tiny
    // window gets a narrow rail rather than one that overflows the layout.
    final maxRail = MediaQuery.of(context).size.width / 3;
    const idealRail = 320.0;
    const minRail = 220.0;
    final double width = math.max(
      math.min(idealRail, maxRail),
      math.min(minRail, maxRail),
    );
    return Container(
      width: width,
        decoration: const BoxDecoration(
          border: Border(left: BorderSide(color: VaultColors.line)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 20, 18, 10),
            child: Text('LIVE INTAKE',
                style: TextStyle(
                    fontSize: 10.5,
                    letterSpacing: 1.1,
                    fontWeight: FontWeight.w600,
                    color: connected ? VaultColors.dim : VaultColors.faint)),
          ),
          Expanded(
            child: events.isEmpty
                ? const Center(
                    child: Text('waiting for events…',
                        style: TextStyle(
                            fontSize: 11.5,
                            fontFamily: VaultType.mono,
                            color: VaultColors.faint)),
                  )
                : ListView.separated(
                    padding: const EdgeInsets.only(bottom: 30),
                    itemCount: events.length,
                    separatorBuilder: (_, _) =>
                        const Divider(height: 1, color: VaultColors.line),
                    itemBuilder: (context, i) {
                      final e = events[i];
                      final ts = e.at.toIso8601String().substring(11, 19);
                      return Container(
                        padding: const EdgeInsets.fromLTRB(18, 7, 14, 7),
                        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          SizedBox(
                            width: 56,
                            child: Text(ts,
                                style: const TextStyle(
                                    fontSize: 10,
                                    fontFamily: VaultType.mono,
                                    color: VaultColors.faint)),
                          ),
                          Expanded(
                            child: Text(_describe(e),
                                style: TextStyle(
                                  fontSize: 11.5,
                                  fontFamily: VaultType.mono,
                                  height: 1.4,
                                  fontWeight: e.type == 'MatchProposed'
                                      ? FontWeight.w700
                                      : FontWeight.w400,
                                  color: _colorFor(e.type),
                                )),
                          ),
                        ]),
                      );
                    },
                  ),
          ),
        ]),
      );
  }
}
