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
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:window_manager/window_manager.dart';

import 'core/providers.dart';
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
import 'features/connection/status_provider.dart';
import 'features/dashboard/dashboard_providers.dart';
import 'features/dashboard/period_provider.dart';
import 'features/events/event_dispatcher.dart';
import 'features/events/event_service.dart';
import 'features/feature_providers.dart';
import 'features/intake/view.dart' as wo_intake;
import 'features/intake/state.dart' as wo_intake_state;
import 'features/ledger/evidence_provider.dart';
import 'features/learning/state.dart' as wo_learning;
import 'features/learning/view.dart' as wo_learning_view;
import 'features/people/view.dart' as wo_people;
import 'features/people/state.dart' as wo_people_state;
import 'features/settings/settings_panel.dart';
import 'features/settings/state.dart' as wo_settings;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // QAV-FLT-07: route all uncaught errors through the privacy-safe logger.
  installErrorHandlers();
  await windowManager.ensureInitialized();
  await windowManager.waitUntilReadyToShow(
    const WindowOptions(
      size: kPopupSize,
      skipTaskbar: true,
      titleBarStyle: TitleBarStyle.hidden,
    ),
  );
  runApp(const ProviderScope(child: Quick2AVaultApp()));
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

class VaultHome extends ConsumerStatefulWidget {
  const VaultHome({super.key});
  @override
  ConsumerState<VaultHome> createState() => _VaultHomeState();
}

class _VaultHomeState extends ConsumerState<VaultHome> {
  MenubarController? _menubar;

  /// Popup (menubar panel) vs the full resizable window.
  bool _fullWindow = false;

  /// Which surface the full window is showing.
  ///
  /// Replaces three mutually-exclusive booleans (_setup / _review / _people).
  /// Those could disagree — the Document Review bug was exactly that: onReview
  /// and onSetup both set _setup, so Review opened Settings. An enum makes the
  /// invalid state unrepresentable.
  VaultTab _tab = VaultTab.ledger;

  bool _learningDrawerOpen = false;

  @override
  void initState() {
    super.initState();
    _initMenubar().catchError((Object e, StackTrace st) {
      appLogger.e('Menubar init failed', error: e, stackTrace: st);
    });
    // Start the connection check and SSE subscription.
    Future.microtask(() {
      ref.read(connectionStatusProvider.notifier).start();
      // Watching eventDispatcherProvider starts the SSE subscription.
      ref.watch(eventDispatcherProvider);
    });
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

  /// WO11 Track A: run one People-desk mutation (owner / merge /
  /// keep-separate), then refetch so the desk reflects the daemon's truth.
  /// Failures surface as a snackbar rather than a silent no-op.
  Future<void> _entityAction(Future<void> Function() action) async {
    try {
      await action();
      // Strict: a failed entity refetch after a successful mutation must
      // surface here — otherwise the desk silently shows pre-mutation state.
      ref.invalidate(entitiesProvider);
      await ref.read(entitiesProvider.future);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  Future<void> _toggleLearning() async {
    final api = ref.read(vaultApiProvider);
    await ref.read(learningProvider.notifier).toggle(api);
  }

  Future<void> _handleLearningAction(String action) async {
    final api = ref.read(vaultApiProvider);
    final split = action.indexOf(':');
    if (split < 0) return;
    final verb = action.substring(0, split);
    final id = int.tryParse(action.substring(split + 1));
    if (id == null) return;
    // WO12 phase 2: reconciliation-ambiguity questions use link/dismiss/later
    // verbs. The daemon routes these through answerLearningQuestion which
    // handles the evidence link, standing rule, or backoff respectively.
    final answer = switch (verb) {
      'confirm' || 'link' => 'yes',
      'dismiss' => 'no',
      'later' => 'later',
      _ => null,
    };
    if (answer == null) {
      setState(() {
        _tab = VaultTab.review;
        _learningDrawerOpen = false;
      });
      return;
    }
    await ref.read(learningProvider.notifier).answerQuestion(api, id, answer);
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
    ref.read(periodSelectionProvider.notifier).select(p);
  }

  /// Switch which hero figure the receipts list explains.
  ///
  /// Clears the open evidence panel: it belongs to a transaction that may not
  /// be in the new list, and leaving it open shows proof for a row the user
  /// can no longer see.
  void _setBucket(String bucket) {
    final current = ref.read(bucketProvider);
    if (current == bucket) return;
    ref.read(bucketProvider.notifier).select(bucket);
    ref.read(selectedTransactionIdProvider.notifier).state = null;
  }

  Future<void> _select(Txn t) async {
    final selectedId = ref.read(selectedTransactionIdProvider);
    // Clicking the open row closes it — with an inline panel the row is now
    // its own toggle, and there is no other way to dismiss it.
    if (selectedId == t.id) {
      ref.read(selectedTransactionIdProvider.notifier).state = null;
      return;
    }
    // Clear the old card FIRST: otherwise the previous transaction's evidence
    // renders under the newly-clicked row until the fetch returns.
    ref.read(selectedTransactionIdProvider.notifier).state = t.id;
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
    final txns = ref.read(transactionsProvider);
    final existing = txns.maybeWhen(
      data: (data) => data.where((t) => t.id == txnId).firstOrNull,
      orElse: () => null,
    );
    if (existing != null) {
      await _select(existing);
      return;
    }
    // The transaction is outside the selected period. Fetching the evidence
    // card directly still shows the proof rather than making the user hunt
    // for the right month.
    ref.read(selectedTransactionIdProvider.notifier).state = txnId;
  }

  Future<void> _onDrop(List<String> paths) async {
    final api = ref.read(vaultApiProvider);
    for (final p in paths) {
      await api.ingest(p);
    }
  }

  Future<void> _refresh() async {
    ref.invalidate(snapshotProvider);
    ref.invalidate(treemapProvider);
    ref.invalidate(transactionsProvider);
    ref.invalidate(periodsProvider);
    ref.invalidate(learningProvider);
    ref.invalidate(intakeStatusProvider);
    ref.invalidate(entitiesProvider);
    ref.invalidate(settingsBundleProvider);
  }

  @override
  Widget build(BuildContext context) {
    // Watch the connection status and SSE connection to drive the UI.
    final connection = ref.watch(connectionStatusProvider);
    final sseStateAsync = ref.watch(sseConnectionStateProvider);
    final sseState = sseStateAsync.valueOrNull ?? SseConnectionState.disconnected;
    final daemonUp = connection.isConnected;

    // Watch the SSE event stream — keeps the subscription alive.
    ref.watch(eventDispatcherProvider);

    // Watch dashboard data.
    final snapAsync = ref.watch(snapshotProvider);
    final treemapAsync = ref.watch(treemapProvider);
    final txnsAsync = ref.watch(transactionsProvider);
    final periodsAsync = ref.watch(periodsProvider);
    final period = ref.watch(periodSelectionProvider);
    final bucket = ref.watch(bucketProvider);
    final feed = ref.watch(eventFeedProvider);
    final selectedId = ref.watch(selectedTransactionIdProvider);

    // Watch feature data.
    final learningAsync = ref.watch(learningProvider);
    final intakeAsync = ref.watch(intakeStatusProvider);
    final entitiesAsync = ref.watch(entitiesProvider);
    final settingsAsync = ref.watch(settingsBundleProvider);
    final intakeArrivals = ref.watch(intakeArrivalsProvider);
    final selectedIntakeId = ref.watch(selectedIntakeIdProvider);

    // Extract values with fallbacks for the popup (which must render even
    // while data is loading).
    final snap = snapAsync.valueOrNull ?? Snapshot.empty;
    final treemap = treemapAsync.valueOrNull ?? TreemapData.empty;
    final txns = txnsAsync.valueOrNull ?? const <Txn>[];
    final periods = periodsAsync.valueOrNull ?? Periods.empty;
    final learningData = learningAsync.valueOrNull ??
        (enabled: true, questions: const <wo_learning.LearningPrompt>[]);
    final intakeItems = intakeAsync.valueOrNull ?? const <wo_intake_state.IntakeItem>[];
    final entities = entitiesAsync.valueOrNull ?? const <wo_people_state.EntitySummary>[];
    final settingsBundle = settingsAsync.valueOrNull ??
        (
          settings: const wo_settings.AppSettings(
              learningEnabled: true, questionBudget: null),
          jurisdiction: wo_settings.JurisdictionPack.india,
        );

    final learningOn = learningData.enabled;
    final reviewCount = learningData.questions.length;
    final appSettings = settingsBundle.settings;
    final jurisdiction = settingsBundle.jurisdiction;

    // SSE connected state.
    final connected = sseState == SseConnectionState.connected;

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
            snapshot: snap,
            // Non-null means the daemon rejected our token, so every figure
            // below is a placeholder rather than a reading of the vault.
            // Staleness rides the same banner: in both cases the numbers on
            // screen do not describe the period the user asked for.
            authError: connection.isAuthError
                ? 'Cannot read the vault — the daemon rejected this app\'s '
                      'token. Your data is intact; the totals below are not real.'
                : (connection.isDegraded
                      ? 'Daemon unreachable — showing the last figures fetched, '
                            'not ${period.month ?? period.fy ?? period.quick ?? "the selected period"}.'
                      : null),
            // The popup renders the same treemap data as the viewer, as a
            // compact band. Without this the data was fetched and discarded.
            treemap: treemap,
            periods: periods,
            selection: period,
            onPeriodChanged: _setPeriod,
            txns: txns,
            feed: feed,
            connected: connected && daemonUp,
            onOpenFull: () => _menubar?.openFullWindow(),
            onQuit: () => exit(0),
            // Settings and Review are no longer popup-local takeovers: they are
            // tabs in the full window. The popup asks for the window and names
            // the tab, so there is exactly ONE place each surface lives.
            onSetup: () => _openTab(VaultTab.settings),
            onReview: () => _openTab(VaultTab.review),
            onRefresh: _refresh,
            onToggleLearning: _toggleLearning,
            learningOn: learningOn,
            reviewCount: reviewCount,
            bucket: bucket,
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
              connected: connected,
              daemonUp: daemonUp,
              learningOn: learningOn,
              learningPending: reviewCount,
              intakeArrivals: intakeArrivals,
              onLearning: learningOn
                  ? () => setState(
                      () => _learningDrawerOpen = !_learningDrawerOpen,
                    )
                  : null,
              onIntake: intakeArrivals == 0
                  ? null
                  : () => setState(() {
                      _tab = VaultTab.intake;
                      ref.read(selectedIntakeIdProvider.notifier).state =
                          intakeItems.firstOrNull?.id;
                      ref.read(intakeArrivalsProvider.notifier).state = 0;
                    }),
            ),
            VaultTabBar(
              current: _tab,
              onChanged: (t) => setState(() {
                _tab = t;
              }),
              reviewCount: reviewCount,
              // Charts is declared but unbuilt. Shown disabled rather than
              // hidden: a greyed tab is an honest promise about what is coming,
              // a missing one is a surprise later.
              disabled: const {VaultTab.charts},
            ),
            if (!daemonUp)
              const Expanded(child: _WaitingForDaemon())
            else
              Expanded(
                child: Stack(
                  children: [
                    Positioned.fill(child: _tabBody(snap, treemap, txns, selectedId, selectedIntakeId, entities, intakeItems, appSettings, jurisdiction, learningData.questions)),
                    if (_learningDrawerOpen)
                      Positioned(
                        top: 0,
                        right: 0,
                        bottom: 0,
                        width: 440,
                        child: Material(
                          elevation: 12,
                          child: wo_learning_view.LearningPanel(
                            enabled: learningOn,
                            questions: learningData.questions,
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
  Widget _tabBody(
    Snapshot snap,
    TreemapData treemap,
    List<Txn> txns,
    String? selectedId,
    String? selectedIntakeId,
    List<wo_people_state.EntitySummary> entities,
    List<wo_intake_state.IntakeItem> intakeItems,
    wo_settings.AppSettings appSettings,
    wo_settings.JurisdictionPack jurisdiction,
    List<wo_learning.LearningPrompt> learningQuestions,
  ) {
    final api = ref.read(vaultApiProvider);
    // Watch the evidence card for the selected transaction.
    final cardAsync = selectedId != null
        ? ref.watch(evidenceCardProvider(selectedId))
        : const AsyncValue<EvidenceCard>.loading();
    final card = cardAsync.valueOrNull;

    return switch (_tab) {
    VaultTab.ledger => LedgerTab(
      snapshot: snap,
      treemap: treemap,
      txns: txns,
      selectedId: selectedId,
      card: card,
      onSelect: _select,
      api: api,
      onSearchHit: _openSearchHit,
      onEdited: _refresh,
    ),
    VaultTab.review => ReviewBrowser(
      api: api,
      initialDocumentId: selectedIntakeId,
    ),
    // WO11 Track A: the desk's owner / merge / keep-separate actions go
    // through the real gateway; every mutation refetches the entity list.
    VaultTab.people => wo_people.EntityDesk(
      entities: entities,
      onSetOwner: (entity, owner) => _entityAction(
        () => VaultEntityGateway(api).setOwner(entity.id, owner: owner),
      ),
      onMerge: (source, target) => _entityAction(
        () => VaultEntityGateway(
          api,
        ).merge(sourceId: source.id, targetId: target.id),
      ),
      onKeepSeparate: (entity, conflict) => _entityAction(
        () => VaultEntityGateway(api).keepSeparate(
          identifier: conflict.identifier,
          entityId: entity.id,
          otherId: conflict.otherId,
        ),
      ),
    ),
    // Work order 07 §G — Intake tab: the unified intake queue.
    // Shows every incoming file with its state. Encrypted PDFs show an
    // inline password field. Irrelevant items show Restore. Nothing is
    // held up by a password-needed item — the rest of the queue keeps
    // processing.
    VaultTab.intake => wo_intake.IntakeView(
      key: ValueKey('intake-${selectedIntakeId ?? "none"}'),
      items: intakeItems,
      onOpenDocument: (item) => setState(() {
        ref.read(selectedIntakeIdProvider.notifier).state =
            item.documentId ?? item.id;
        _tab = VaultTab.review;
      }),
    ),
    VaultTab.settings => SettingsPanel(
      settings: appSettings,
      pack: jurisdiction,
      onSettingsChanged: (next) async {
        final api = ref.read(vaultApiProvider);
        await ref.read(settingsBundleProvider.notifier).saveSettings(
              api,
              appSettings,
              next,
            );
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
