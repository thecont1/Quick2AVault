/// QAV-FLT-05/06: Event feed and SSE-driven state updates.
///
/// Connects the [EventService] to the feature providers. When events arrive,
/// this provider updates the learning questions, intake arrivals, event feed,
/// and triggers dashboard refreshes — replacing the `_listen()` method in the
/// old god widget.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api.dart';
import '../../core/providers.dart';
import '../dashboard/dashboard_providers.dart';
import '../events/event_service.dart';
import '../feature_providers.dart';
import 'package:quick2avault_desktop/features/learning/state.dart' as learning;

/// The event feed — a rolling list of the last 60 events.
final StateProvider<List<VaultEvent>> eventFeedProvider =
    StateProvider<List<VaultEvent>>((ref) => const []);

/// Intake arrivals counter — incremented when a new document arrives.
final StateProvider<int> intakeArrivalsProvider = StateProvider<int>(
  (ref) => 0,
);

/// The currently selected intake item id.
final StateProvider<String?> selectedIntakeIdProvider = StateProvider<String?>(
  (ref) => null,
);

/// A provider that subscribes to the SSE event stream and dispatches events
/// to the relevant feature providers. Kept alive for the app's lifetime.
///
/// Watch this provider from the top-level widget to ensure the subscription
/// stays active.
final Provider<void> eventDispatcherProvider = Provider<void>((ref) {
  final service = ref.watch(sseServiceProvider);
  final logger = ref.watch(appLoggerProvider);

  final subscription = service.events.listen(
    (e) {
      // Update the event feed (skip 'Ready' — it's the daemon's hello).
      if (e.type != 'Ready') {
        final feed = ref.read(eventFeedProvider);
        final newFeed = [e, ...feed.take(59)];
        ref.read(eventFeedProvider.notifier).state = newFeed;
      }

      // Learning questions: add new, remove answered.
      if (e.type == 'learning.question') {
        final id = '${e.data['question_id'] ?? ''}';
        final question = learning.LearningPrompt(
          id: id,
          prompt: '${e.data['prompt'] ?? ''}',
          why: '${e.data['why'] ?? ''}',
          trigger: '${(e.data['trigger'] as Map?)?['kind'] ?? ''}',
          novelty:
              ((e.data['trigger'] as Map?)?['noveltyScore'] as num?)
                  ?.toDouble() ??
              1,
        );
        ref.read(learningProvider.notifier).addQuestion(question);
      } else if (e.type == 'learning.answer') {
        final id = '${e.data['question_id'] ?? ''}';
        ref.read(learningProvider.notifier).removeQuestion(id);
      }

      // Intake arrivals: count new documents.
      if (e.type == 'PipelineStateChanged' &&
          e.data['to_state'] == 'received') {
        ref.read(intakeArrivalsProvider.notifier).state =
            ref.read(intakeArrivalsProvider) + 1;
        ref.read(selectedIntakeIdProvider.notifier).state =
            '${e.data['document_id'] ?? ''}';
      }

      // Refresh dashboard data on events that change what the ledger shows.
      const refreshOn = {
        'TransactionRecorded',
        'MatchProposed',
        'AnalysisComplete',
        'DocumentReceived',
        'DocumentDuplicate',
        'BatchFinished',
        'IntakeAccepted',
        'IntakeIrrelevant',
        'IntakeDuplicate',
        'IntakeFailed',
        'IntakeRestored',
        'PipelineStateChanged',
        'learning.question',
        'learning.answer',
        'learning.rule.applied',
      };
      if (e.type == 'Ready' || refreshOn.contains(e.type)) {
        ref.invalidate(snapshotProvider);
        ref.invalidate(treemapProvider);
        ref.invalidate(transactionsProvider);
        ref.invalidate(periodsProvider);
        ref.invalidate(learningProvider);
        ref.invalidate(intakeStatusProvider);
        ref.invalidate(entitiesProvider);
        ref.invalidate(settingsBundleProvider);
      }
    },
    onError: (e) {
      logger.w('SSE stream error', error: e);
    },
  );

  // Connect on start.
  service.connect();

  ref.onDispose(() {
    subscription.cancel();
  });
});
