/// Quick2AVault — macOS desktop client.
///
/// A pure client of the Core API daemon. No database, no business logic, no
/// duplicated rules: the same contract the web UI and the MCP server speak.
///
/// Design follows the Glaze app: calm dark surface, amber for "needs your
/// attention", emerald for "settled", generous whitespace, tabular numerals
/// wherever money appears.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'api.dart';
import 'menubar.dart';
import 'theme.dart';
import 'widgets/hero_row.dart';
import 'widgets/txn_card.dart';
import 'widgets/evidence_panel.dart';
import 'widgets/feed_rail.dart';
import 'widgets/drop_target.dart';
import 'widgets/popup_view.dart';
import 'widgets/setup_view.dart';
import 'widgets/period_bar.dart';
import 'widgets/people_view.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  await windowManager.waitUntilReadyToShow(
    const WindowOptions(
      size: kPopupSize,
      skipTaskbar: true,
      titleBarStyle: TitleBarStyle.hidden,
    ),
  );
  runApp(const Quick2AVaultApp());
}

class Quick2AVaultApp extends StatelessWidget {
  const Quick2AVaultApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Quick2AVault',
        debugShowCheckedModeBanner: false,
        theme: vaultTheme,
        home: const VaultHome(),
      );
}

class VaultHome extends StatefulWidget {
  const VaultHome({super.key});
  @override
  State<VaultHome> createState() => _VaultHomeState();
}

class _VaultHomeState extends State<VaultHome> {
  late final VaultApi _api;
  MenubarController? _menubar;

  Snapshot _snap = Snapshot.empty;
  Periods _periods = Periods.empty;
  /// Defaults to the current month — the period a user checks most often.
  PeriodSelection _period = PeriodSelection.thisMonth;
  List<Txn> _txns = const [];
  final List<VaultEvent> _feed = [];
  EvidenceCard? _card;
  String? _selectedId;
  bool _connected = false;
  bool _daemonUp = false;
  /// Popup (menubar panel) vs the full resizable window.
  bool _fullWindow = false;
  /// Setup pane overrides whichever surface is showing.
  bool _setup = false;
  bool _people = false;
  bool _learningOn = true;
  int _reviewCount = 0;

  @override
  void initState() {
    super.initState();
    // Wired via --dart-define so the same binary points at any daemon.
    // NOTE: no default token. A build without --dart-define=Q2AV_TOKEN gets an
    // empty string and fails auth loudly, rather than shipping a guessable
    // shared secret that would let any local process read the ledger.
    const base = String.fromEnvironment('Q2AV_URL', defaultValue: 'http://127.0.0.1:4479');
    const token = String.fromEnvironment('Q2AV_TOKEN');
    _api = VaultApi(baseUrl: base, token: token);
    _initMenubar();
    _boot();
  }

  Future<void> _initMenubar() async {
    final m = MenubarController(
      onOpenFull: () => setState(() => _fullWindow = true),
      onQuit: () => exit(0),
    );
    await m.init();
    if (mounted) setState(() => _menubar = m);
    // QA / debugging aid: start straight in the full Document Viewer instead
    // of the menubar popup, so the window can be driven and screenshotted
    // without simulating a tray click.
    //   flutter run --dart-define=Q2AV_START_FULL=true
    if (const bool.fromEnvironment('Q2AV_START_FULL')) {
      await m.openFullWindow();
    }
  }

  Future<void> _boot() async {
    final up = await _api.health();
    if (!mounted) return;
    setState(() => _daemonUp = up);
    if (up) {
      await _refresh();
      _listen();
    } else {
      // Poll until the daemon appears, so launch order doesn't matter.
      Future.delayed(const Duration(seconds: 2), _boot);
    }
  }

  Future<void> _refresh() async {
    try {
      final results = await Future.wait([
        _api.snapshot(
          period: _period.quick,
          month: _period.month,
          fy: _period.fy,
        ),
        _api.transactions(),
        _api.periods(),
      ]);
      if (!mounted) return;
      setState(() {
        _snap = results[0] as Snapshot;
        _txns = results[1] as List<Txn>;
        _periods = results[2] as Periods;
      });
      final l = await _api.learning();
      if (mounted) {
        setState(() {
          _learningOn = l.enabled;
          _reviewCount = l.questions.length;
        });
      }
    } catch (_) {/* transient; the SSE stream will trigger another */}
  }

  Future<void> _toggleLearning() async {
    final next = !_learningOn;
    setState(() => _learningOn = next);
    try {
      await _api.toggleLearning(next);
    } catch (_) {
      if (mounted) setState(() => _learningOn = !next);
    }
  }

  void _setPeriod(PeriodSelection p) {
    setState(() => _period = p);
    _refresh();
  }

  void _listen() {
    _api.events().listen(
      (e) {
        if (!mounted) return;
        setState(() {
          _connected = true;
          if (e.type != 'Ready') _feed.insert(0, e);
          if (_feed.length > 60) _feed.removeLast();
        });
        const refreshOn = {
          'TransactionRecorded', 'MatchProposed', 'AnalysisComplete',
          'DocumentReceived', 'DocumentDuplicate',
        };
        if (refreshOn.contains(e.type)) _refresh();
      },
      onError: (_) {
        if (mounted) setState(() => _connected = false);
        Future.delayed(const Duration(seconds: 2), _listen);
      },
      onDone: () {
        if (mounted) setState(() => _connected = false);
        Future.delayed(const Duration(seconds: 2), _listen);
      },
    );
  }

  Future<void> _select(Txn t) async {
    // Clicking the open row closes it — with an inline panel the row is now
    // its own toggle, and there is no other way to dismiss it.
    if (_selectedId == t.id) {
      setState(() {
        _selectedId = null;
        _card = null;
      });
      return;
    }
    // Clear the old card FIRST: otherwise the previous transaction's evidence
    // renders under the newly-clicked row until the fetch returns.
    setState(() {
      _selectedId = t.id;
      _card = null;
    });
    try {
      final card = await _api.evidenceCard(t.id);
      // Guard against a slow response for a row the user has since moved off.
      if (mounted && _selectedId == t.id) setState(() => _card = card);
    } catch (_) {}
  }

  Future<void> _onDrop(List<String> paths) async {
    for (final p in paths) {
      await _api.ingest(p);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_people) {
      return Scaffold(
        backgroundColor: VaultColors.bg,
        body: PeopleView(api: _api, onClose: () => setState(() => _people = false)),
      );
    }

    if (_setup) {
      return Scaffold(
        backgroundColor: VaultColors.bg,
        body: SetupView(
          api: _api,
          onClose: () => setState(() => _setup = false),
          onOpenPeople: () => setState(() { _setup = false; _people = true; }),
        ),
      );
    }

    // Menubar panel — the default surface. Compact, glanceable, dismissed on
    // click-away. The full window is opened deliberately.
    if (!_fullWindow) {
      return Scaffold(
        backgroundColor: Colors.transparent,
        body: VaultDropTarget(
          onDrop: _onDrop,
          child: PopupView(
            snapshot: _snap,
            periods: _periods,
            selection: _period,
            onPeriodChanged: _setPeriod,
            txns: _txns,
            feed: _feed,
            connected: _connected && _daemonUp,
            onOpenFull: () => _menubar?.openFullWindow(),
            onQuit: () => exit(0),
            onSetup: () => setState(() => _setup = true),
            onReview: () => setState(() => _setup = true),
            onRefresh: _refresh,
            onToggleLearning: _toggleLearning,
            learningOn: _learningOn,
            reviewCount: _reviewCount,
          ),
        ),
      );
    }

    return Scaffold(
      backgroundColor: VaultColors.bg,
      body: VaultDropTarget(
        onDrop: _onDrop,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _TitleBar(connected: _connected, daemonUp: _daemonUp),
            if (!_daemonUp)
              const Expanded(child: _WaitingForDaemon())
            else
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      flex: 3,
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(28, 20, 20, 40),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            HeroRow(snapshot: _snap, txns: _txns),
                            const SizedBox(height: 22),
                            _SectionLabel('Transactions'),
                            const SizedBox(height: 10),
                            if (_txns.isEmpty)
                              const _EmptyState()
                            else
                              // Evidence opens INLINE, directly beneath the
                              // transaction it belongs to. Rendering it after
                              // the whole list forced a scroll to the bottom
                              // and broke the link between claim and proof.
                              ..._txns.map((t) => Padding(
                                    padding: const EdgeInsets.only(bottom: 10),
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        TxnCard(
                                          txn: t,
                                          selected: _selectedId == t.id,
                                          onTap: () => _select(t),
                                        ),
                                        if (_selectedId == t.id && _card != null)
                                          Padding(
                                            padding: const EdgeInsets.only(
                                                top: 8, left: 14),
                                            child: EvidencePanel(card: _card!),
                                          ),
                                      ],
                                    ),
                                  )),
                          ],
                        ),
                      ),
                    ),
                    FeedRail(events: _feed, connected: _connected),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _TitleBar extends StatelessWidget {
  final bool connected;
  final bool daemonUp;
  const _TitleBar({required this.connected, required this.daemonUp});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(28, 26, 24, 14),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: VaultColors.line)),
        ),
        child: Row(
          children: [
            const Text('Quick2AVault',
                style: TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w600, color: VaultColors.ink)),
            const SizedBox(width: 10),
            const Expanded(
              child: Text('— every rupee a transaction, every transaction evidenced',
                  style: TextStyle(fontSize: 13.5, color: VaultColors.faint)),
            ),
            _StatusDot(connected: connected, daemonUp: daemonUp),
          ],
        ),
      );
}

class _StatusDot extends StatelessWidget {
  final bool connected;
  final bool daemonUp;
  const _StatusDot({required this.connected, required this.daemonUp});

  @override
  Widget build(BuildContext context) {
    final (color, label) = !daemonUp
        ? (VaultColors.out, 'daemon offline')
        : connected
            ? (VaultColors.ok, 'live')
            : (VaultColors.warn, 'reconnecting');
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(width: 7, height: 7,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
      const SizedBox(width: 7),
      Text(label,
          style: TextStyle(fontSize: 11, color: color, fontFamily: VaultType.mono)),
    ]);
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);
  @override
  Widget build(BuildContext context) => Text(text.toUpperCase(),
      style: const TextStyle(
          fontSize: 10.5, letterSpacing: 1.1,
          fontWeight: FontWeight.w600, color: VaultColors.dim));
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 44),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(color: VaultColors.line),
          color: VaultColors.panel,
        ),
        child: const Column(children: [
          Text('No transactions yet',
              style: TextStyle(color: VaultColors.dim, fontSize: 13.5)),
          SizedBox(height: 6),
          Text('Drop a document anywhere in this window',
              style: TextStyle(color: VaultColors.faint, fontSize: 12)),
        ]),
      );
}

class _WaitingForDaemon extends StatelessWidget {
  const _WaitingForDaemon();
  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Waiting for the vault daemon',
              style: TextStyle(color: VaultColors.dim, fontSize: 14)),
          const SizedBox(height: 8),
          Text('npx tsx daemon/main.ts',
              style: TextStyle(
                  color: VaultColors.faint, fontSize: 12, fontFamily: VaultType.mono)),
        ]),
      );
}
