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
import 'window_store.dart';
import 'theme.dart';
import 'widgets/drop_target.dart';
import 'widgets/popup_view.dart';
import 'widgets/period_bar.dart';
import 'widgets/vault_tabs.dart';
import 'widgets/ledger_tab.dart';
import 'widgets/review_browser.dart';
import 'features/adapters.dart';
import 'features/intake/view.dart' as wo_intake;
import 'features/intake/state.dart' as wo_intake_state;
import 'features/learning/state.dart' as wo_learning;
import 'features/learning/view.dart' as wo_learning_view;
import 'features/people/view.dart' as wo_people;
import 'features/people/state.dart' as wo_people_state;
import 'features/settings/settings_panel.dart';
import 'features/settings/state.dart' as wo_settings;

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
  TreemapData _treemap = TreemapData.empty;

  /// Set when the daemon rejects our token. Non-null means the numbers on
  /// screen are meaningless and must not be presented as the vault's state.
  String? _authError;
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

  /// Which surface the full window is showing.
  ///
  /// Replaces three mutually-exclusive booleans (_setup / _review / _people).
  /// Those could disagree — the Document Review bug was exactly that: onReview
  /// and onSetup both set _setup, so Review opened Settings. An enum makes the
  /// invalid state unrepresentable.
  VaultTab _tab = VaultTab.ledger;
  bool _learningOn = true;
  int _reviewCount = 0;
  List<wo_learning.LearningPrompt> _learningQuestions = const [];
  List<wo_intake_state.IntakeItem> _intakeItems = const [];
  List<wo_people_state.EntitySummary> _entities = const [];
  wo_settings.AppSettings _appSettings = const wo_settings.AppSettings(
    learningEnabled: true,
    questionBudget: null,
  );
  wo_settings.JurisdictionPack _jurisdiction =
      wo_settings.JurisdictionPack.india;
  int _intakeArrivals = 0;
  String? _selectedIntakeId;
  bool _learningDrawerOpen = false;

  /// True when the last fetch failed, so the figures on screen describe an
  /// older request than the period the user has selected. Surfaced in the UI —
  /// silently stale numbers are worse than an error.
  bool _stale = false;

  /// Guards against overlapping reconnect loops.
  bool _reconnecting = false;

  /// Which hero figure the receipts list is explaining.
  ///
  /// Defaults to spending: it is the figure people actually interrogate, and
  /// an unfiltered "everything" list answers no question in particular.
  String _bucket = 'spending';

  @override
  void initState() {
    super.initState();
    // Wired via --dart-define so the same binary points at any daemon.
    // NOTE: no default token. A build without --dart-define=Q2AV_TOKEN gets an
    // empty string and fails auth loudly, rather than shipping a guessable
    // shared secret that would let any local process read the ledger.
    // 4477 is the daemon's default port (daemon/main.ts). These two defaults
    // MUST agree: a release build bakes this in, so a mismatch produces an app
    // that connects to nothing and looks like an empty vault rather than a
    // configuration error.
    const base = String.fromEnvironment(
      'Q2AV_URL',
      defaultValue: 'http://127.0.0.1:4477',
    );
    const token = String.fromEnvironment('Q2AV_TOKEN');
    _api = VaultApi(baseUrl: base, token: token);
    // Errors MUST be surfaced. This was fire-and-forget, so any throw inside
    // _initMenubar (a missing plugin registration, a platform channel that is
    // not ready) vanished silently: the tray never installed, the QA start
    // flags never fired, and the app just sat at its startup geometry looking
    // like a layout bug rather than a crashed initialiser.
    _initMenubar().catchError((Object e, StackTrace st) {
      // ignore: avoid_print
      print('MENUBAR INIT FAILED: $e\n$st');
    });
    _boot();
  }

  Future<void> _initMenubar() async {
    // Load remembered geometry BEFORE the controller can show a window,
    // otherwise the first showPopup() reads an empty store and falls back to
    // the tray anchor even though a saved position exists.
    final store = WindowStore.defaultLocation();
    await store.load();
    final m = MenubarController(
      store: store,
      onOpenFull: () => setState(() => _fullWindow = true),
      // The return path. Without it _fullWindow was a latch: once true it
      // never cleared, so every later tray click rendered the full viewer
      // inside a 420px popup.
      onShowPopup: () {
        if (mounted && _fullWindow) setState(() => _fullWindow = false);
      },
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
    // Same aid for the POPUP, which is otherwise only reachable by clicking a
    // tray icon — impossible to drive when the menubar is auto-hidden.
    //   flutter run --dart-define=Q2AV_START_POPUP=true
    if (const bool.fromEnvironment('Q2AV_START_POPUP')) {
      await m.showPopup();
    }
    // QA: exercise the full -> popup transition that regressed once. Opens the
    // viewer, then returns to the popup exactly as a tray click does, so the
    // round trip can be screenshotted without simulating a status-item click
    // (macOS does not expose the tray context menu to the accessibility API).
    //   flutter build macos --dart-define=Q2AV_QA_ROUNDTRIP=true
    if (const bool.fromEnvironment('Q2AV_QA_ROUNDTRIP')) {
      await m.openFullWindow();
      await Future<void>.delayed(const Duration(seconds: 2));
      await m.showPopup();
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
        _api.transactions(
          period: _period.quick,
          month: _period.month,
          fy: _period.fy,
          // The receipts list explains ONE hero figure at a time.
          bucket: _bucket,
        ),
        _api.periods(),
        // Same period as the snapshot — the treemap must always total to the
        // spending figure shown above it, never to a different window.
        _api.treemap(
          period: _period.quick,
          month: _period.month,
          fy: _period.fy,
        ),
      ]);
      if (!mounted) return;
      setState(() {
        _snap = results[0] as Snapshot;
        _txns = results[1] as List<Txn>;
        _periods = results[2] as Periods;
        _treemap = results[3] as TreemapData;
        // A successful fetch is the only proof the daemon is reachable.
        _daemonUp = true;
        _stale = false;
      });
      final l = await _api.learning();
      if (mounted) {
        setState(() {
          _learningOn = l.enabled;
          _reviewCount = l.questions.length;
          _learningQuestions = l.questions
              .map(
                (q) => wo_learning.LearningPrompt(
                  id: '${q['id'] ?? ''}',
                  prompt: '${q['question'] ?? ''}',
                  why: q['context']?.toString() ?? '${q['trigger'] ?? ''}',
                  trigger: '${q['trigger'] ?? ''}',
                  novelty: (q['novelty_score'] as num?)?.toDouble() ?? 1,
                ),
              )
              .toList();
          _authError = null;
        });
      }
      final featureResults = await Future.wait<Object>([
        _api.featureIntakeStatus(),
        _api.featureEntities(),
        _api.featureSettings(),
        _api.featureJurisdiction(),
      ]);
      if (mounted) {
        final intake = featureResults[0] as List<wo_intake_state.IntakeItem>;
        setState(() {
          _intakeItems = intake;
          _entities = featureResults[1] as List<wo_people_state.EntitySummary>;
          _appSettings = featureResults[2] as wo_settings.AppSettings;
          _jurisdiction = featureResults[3] as wo_settings.JurisdictionPack;
          _learningOn = _appSettings.learningEnabled;
          _intakeArrivals = intake
              .where(
                (item) => item.state != wo_intake_state.PipelineState.complete,
              )
              .length;
        });
      }
    } on VaultAuthException catch (e) {
      // NEVER fall through to zeros here. Rendering Rs 0 for an auth failure
      // reads as "your vault is empty" — indistinguishable from real data loss,
      // and alarming when the ledger is in fact intact. Say what is wrong.
      if (mounted) setState(() => _authError = e.toString());
    } catch (_) {
      // A failed refresh USED to be swallowed here with "the SSE stream will
      // trigger another". It will not: when the daemon is down the stream is
      // down too. The visible symptom was the period selector appearing to do
      // nothing — the button highlighted because _period had changed, the
      // fetch failed, and the figures silently kept their old values.
      //
      // So: mark the data stale, mark the daemon unreachable, and start
      // polling for its return. The UI can then say the numbers are frozen
      // instead of quietly lying about which period they describe.
      if (!mounted) return;
      setState(() {
        _stale = true;
        _daemonUp = false;
      });
      _scheduleReconnect();
    }
  }

  /// Poll for the daemon after a failed fetch.
  ///
  /// Guarded by _reconnecting so a burst of failures (four parallel requests)
  /// cannot start four overlapping loops.
  void _scheduleReconnect() {
    if (_reconnecting) return;
    _reconnecting = true;
    Future.delayed(const Duration(seconds: 2), () async {
      if (!mounted) {
        _reconnecting = false;
        return;
      }
      _reconnecting = false;
      final up = await _api.health();
      if (up) {
        await _refresh();
      } else {
        _scheduleReconnect();
      }
    });
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

  Future<void> _handleLearningAction(String action) async {
    final split = action.indexOf(':');
    if (split < 0) return;
    final verb = action.substring(0, split);
    final id = int.tryParse(action.substring(split + 1));
    if (id == null) return;
    if (verb == 'confirm') {
      await _api.answerLearning(id, 'yes');
    } else if (verb == 'later') {
      await _api.dismissLearning(id);
    } else {
      setState(() {
        _tab = VaultTab.review;
        _learningDrawerOpen = false;
      });
      return;
    }
    if (!mounted) return;
    setState(() {
      _learningQuestions = _learningQuestions
          .where((question) => question.id != '$id')
          .toList();
      _reviewCount = _learningQuestions.length;
    });
  }

  /// Open the full window on a given tab.
  ///
  /// The popup's Settings and Review buttons route through here. Setting the
  /// tab BEFORE opening the window matters: openFullWindow() fires onOpenFull,
  /// which flips _fullWindow and triggers a rebuild — if the tab were set
  /// after, the window would flash the ledger first.
  void _openTab(VaultTab tab) {
    setState(() => _tab = tab);
    _menubar?.openFullWindow();
  }

  void _setPeriod(PeriodSelection p) {
    setState(() => _period = p);
    _refresh();
  }

  /// Switch which hero figure the receipts list explains.
  ///
  /// Clears the open evidence panel: it belongs to a transaction that may not
  /// be in the new list, and leaving it open shows proof for a row the user
  /// can no longer see.
  void _setBucket(String bucket) {
    if (_bucket == bucket) return;
    setState(() {
      _bucket = bucket;
      _selectedId = null;
      _card = null;
    });
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
          if (e.type == 'learning.question') {
            final id = '${e.data['questionId'] ?? ''}';
            if (!_learningQuestions.any((question) => question.id == id)) {
              _learningQuestions = [
                wo_learning.LearningPrompt(
                  id: id,
                  prompt: '${e.data['prompt'] ?? ''}',
                  why: '${e.data['why'] ?? ''}',
                  trigger: '${(e.data['trigger'] as Map?)?['kind'] ?? ''}',
                  novelty:
                      ((e.data['trigger'] as Map?)?['noveltyScore'] as num?)
                          ?.toDouble() ??
                      1,
                ),
                ..._learningQuestions,
              ];
              _reviewCount = _learningQuestions.length;
            }
          } else if (e.type == 'learning.answer') {
            final id = '${e.data['questionId'] ?? ''}';
            _learningQuestions = _learningQuestions
                .where((question) => question.id != id)
                .toList();
            _reviewCount = _learningQuestions.length;
          } else if (e.type == 'PipelineStateChanged' &&
              e.data['to_state'] == 'received') {
            _intakeArrivals += 1;
            _selectedIntakeId = '${e.data['document_id'] ?? ''}';
          }
        });
        // Verified against the daemon's actual emissions (probe: drop a
        // fixture, read the SSE stream). The daemon emits nine types; these
        // are the ones that change what the ledger shows.
        //
        // 'BatchFinished' is easy to forget and matters most: a bulk Gmail
        // sync ends with it, and the per-document events during a large import
        // can be coalesced, so without it the totals sit stale after an import.
        //
        // Deliberately NOT here: 'JobStateChanged' (fires ~6x per document —
        // pure churn) and 'MarkdownReady' (conversion finished, but no ledger
        // figure has changed yet; 'AnalysisComplete' follows and covers it).
        const refreshOn = {
          'TransactionRecorded', 'MatchProposed', 'AnalysisComplete',
          'DocumentReceived', 'DocumentDuplicate', 'BatchFinished',
          // Work order 06 — intake events that change what the Irrelevant view
          // and intake feed show. IntakeRestored must refresh because a restore
          // promotes an irrelevant item into the ledger.
          'IntakeAccepted', 'IntakeIrrelevant', 'IntakeDuplicate',
          'IntakeFailed', 'IntakeRestored',
          'PipelineStateChanged', 'learning.question', 'learning.answer',
          'learning.rule.applied',
        };
        // 'Ready' is the daemon's hello — it arrives on every (re)connect.
        // Refreshing on it is how the app recovers after the daemon restarts:
        // without this the stream reconnected, the dot went green, and the
        // figures stayed frozen at whatever they were before the outage.
        if (e.type == 'Ready' || refreshOn.contains(e.type)) _refresh();
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

  /// Open a search result.
  ///
  /// A hit carries the transaction its document backs. An UNLINKED document
  /// has none — selecting it would silently do nothing, so the user is told
  /// why instead of being left staring at an unchanged screen.
  Future<void> _openSearchHit(SearchHit hit) async {
    final txnId = hit.transactionId;
    if (txnId == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${hit.filename} is not linked to a transaction yet'),
        ),
      );
      return;
    }
    final existing = _txns.where((t) => t.id == txnId).firstOrNull;
    if (existing != null) {
      await _select(existing);
      return;
    }
    // The transaction is outside the selected period. Fetching the evidence
    // card directly still shows the proof rather than making the user hunt
    // for the right month.
    setState(() {
      _selectedId = txnId;
      _card = null;
    });
    try {
      final card = await _api.evidenceCard(txnId);
      if (mounted && _selectedId == txnId) setState(() => _card = card);
    } catch (_) {}
  }

  Future<void> _onDrop(List<String> paths) async {
    for (final p in paths) {
      await _api.ingest(p);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Menubar panel — the glanceable surface. Compact, dismissed on click-away.
    // The full window is opened deliberately and holds EVERYTHING the user can
    // do, as tabs.
    //
    // The width check is a SAFETY NET, not the primary switch. The Document
    // Viewer's three-column hero row and side rail cannot fit 420px: if state
    // and geometry ever disagree again, render the popup rather than a broken
    // viewer squeezed into a panel.
    final tooNarrowForViewer =
        MediaQuery.of(context).size.width < kFullSize.width * 0.6;
    if (!_fullWindow || tooNarrowForViewer) {
      return Scaffold(
        backgroundColor: Colors.transparent,
        body: VaultDropTarget(
          onDrop: _onDrop,
          child: PopupView(
            snapshot: _snap,
            // Non-null means the daemon rejected our token, so every figure
            // below is a placeholder rather than a reading of the vault.
            // Staleness rides the same banner: in both cases the numbers on
            // screen do not describe the period the user asked for.
            authError: _authError != null
                ? 'Cannot read the vault — the daemon rejected this app\'s '
                      'token. Your data is intact; the totals below are not real.'
                : (_stale
                      ? 'Daemon unreachable — showing the last figures fetched, '
                            'not ${_period.month ?? _period.fy ?? _period.quick ?? "the selected period"}.'
                      : null),
            // The popup renders the same treemap data as the viewer, as a
            // compact band. Without this the data was fetched and discarded.
            treemap: _treemap,
            periods: _periods,
            selection: _period,
            onPeriodChanged: _setPeriod,
            txns: _txns,
            feed: _feed,
            connected: _connected && _daemonUp,
            onOpenFull: () => _menubar?.openFullWindow(),
            onQuit: () => exit(0),
            // Settings and Review are no longer popup-local takeovers: they are
            // tabs in the full window. The popup asks for the window and names
            // the tab, so there is exactly ONE place each surface lives.
            onSetup: () => _openTab(VaultTab.settings),
            onReview: () => _openTab(VaultTab.review),
            onRefresh: _refresh,
            onToggleLearning: _toggleLearning,
            learningOn: _learningOn,
            reviewCount: _reviewCount,
            bucket: _bucket,
            onBucketChanged: _setBucket,
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
            _TitleBar(
              connected: _connected,
              daemonUp: _daemonUp,
              learningOn: _learningOn,
              learningPending: _reviewCount,
              intakeArrivals: _intakeArrivals,
              onLearning: _learningOn
                  ? () => setState(
                      () => _learningDrawerOpen = !_learningDrawerOpen,
                    )
                  : null,
              onIntake: _intakeArrivals == 0
                  ? null
                  : () => setState(() {
                      _tab = VaultTab.intake;
                      _selectedIntakeId = _intakeItems.firstOrNull?.id;
                      _intakeArrivals = 0;
                    }),
            ),
            VaultTabBar(
              current: _tab,
              onChanged: (t) => setState(() {
                _tab = t;
              }),
              reviewCount: _reviewCount,
              // Charts is declared but unbuilt. Shown disabled rather than
              // hidden: a greyed tab is an honest promise about what is coming,
              // a missing one is a surprise later.
              disabled: const {VaultTab.charts},
            ),
            if (!_daemonUp)
              const Expanded(child: _WaitingForDaemon())
            else
              Expanded(
                child: Stack(
                  children: [
                    Positioned.fill(child: _tabBody()),
                    if (_learningDrawerOpen)
                      Positioned(
                        top: 0,
                        right: 0,
                        bottom: 0,
                        width: 440,
                        child: Material(
                          elevation: 12,
                          child: wo_learning_view.LearningPanel(
                            enabled: _learningOn,
                            questions: _learningQuestions,
                            onAction: _handleLearningAction,
                            onOpenReview: () => setState(() {
                              _tab = VaultTab.review;
                              _learningDrawerOpen = false;
                            }),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// The body for the selected tab.
  ///
  /// Every surface is built from state the shell already holds, so switching
  /// tabs never refetches and never loses the selected transaction. Pipeline
  /// events remain subscribed for Intake and Learning, but Ledger deliberately
  /// has no live-intake rail.
  Widget _tabBody() => switch (_tab) {
    VaultTab.ledger => LedgerTab(
      snapshot: _snap,
      treemap: _treemap,
      txns: _txns,
      selectedId: _selectedId,
      card: _card,
      onSelect: _select,
      api: _api,
      onSearchHit: _openSearchHit,
      onEdited: _refresh,
    ),
    VaultTab.review => ReviewBrowser(
      api: _api,
      initialDocumentId: _selectedIntakeId,
    ),
    VaultTab.people => wo_people.EntityDesk(entities: _entities),
    // Work order 07 §G — Intake tab: the unified intake queue.
    // Shows every incoming file with its state. Encrypted PDFs show an
    // inline password field. Irrelevant items show Restore. Nothing is
    // held up by a password-needed item — the rest of the queue keeps
    // processing.
    VaultTab.intake => wo_intake.IntakeView(
      key: ValueKey('intake-${_selectedIntakeId ?? "none"}'),
      items: _intakeItems,
      onOpenDocument: (item) => setState(() {
        _selectedIntakeId = item.documentId ?? item.id;
        _tab = VaultTab.review;
      }),
    ),
    VaultTab.settings => SettingsPanel(
      settings: _appSettings,
      pack: _jurisdiction,
      onSettingsChanged: (next) async {
        final previous = _appSettings;
        setState(() {
          _appSettings = next;
          _learningOn = next.learningEnabled;
        });
        try {
          await _api.saveFeatureSettings(previous, next);
        } catch (_) {
          if (mounted) {
            setState(() {
              _appSettings = previous;
              _learningOn = previous.learningEnabled;
            });
          }
        }
      },
    ),
    VaultTab.charts => const ComingSoon(
      title: 'Charts',
      detail:
          'Spending over time, category trends and counterparty '
          'concentration. The data is already in the vault — this tab is '
          'the view that has not been built yet.',
    ),
  };
}

class _TitleBar extends StatelessWidget {
  final bool connected;
  final bool daemonUp;
  final bool learningOn;
  final int learningPending;
  final int intakeArrivals;
  final VoidCallback? onLearning;
  final VoidCallback? onIntake;
  const _TitleBar({
    required this.connected,
    required this.daemonUp,
    required this.learningOn,
    required this.learningPending,
    required this.intakeArrivals,
    this.onLearning,
    this.onIntake,
  });

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(28, 26, 24, 14),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: VaultColors.line)),
    ),
    child: Row(
      children: [
        const Text(
          'Quick2AVault',
          style: TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w600,
            color: VaultColors.ink,
          ),
        ),
        const SizedBox(width: 10),
        const Expanded(
          child: Text(
            '— every rupee a transaction, every transaction evidenced',
            style: TextStyle(fontSize: 13.5, color: VaultColors.faint),
          ),
        ),
        TextButton.icon(
          onPressed: onLearning,
          icon: const Icon(Icons.auto_awesome_outlined, size: 15),
          label: Text(
            learningOn
                ? 'Learning on · $learningPending pending'
                : 'Learning off',
          ),
        ),
        TextButton.icon(
          onPressed: onIntake,
          icon: const Icon(Icons.inbox_outlined, size: 15),
          label: Text('$intakeArrivals arrivals'),
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
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 7),
        Text(
          label,
          style: TextStyle(
            fontSize: 11,
            color: color,
            fontFamily: VaultType.mono,
          ),
        ),
      ],
    );
  }
}

class _WaitingForDaemon extends StatelessWidget {
  const _WaitingForDaemon();
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'Waiting for the vault daemon',
          style: TextStyle(color: VaultColors.dim, fontSize: 14),
        ),
        const SizedBox(height: 8),
        Text(
          'npx tsx daemon/main.ts',
          style: TextStyle(
            color: VaultColors.faint,
            fontSize: 12,
            fontFamily: VaultType.mono,
          ),
        ),
      ],
    ),
  );
}
