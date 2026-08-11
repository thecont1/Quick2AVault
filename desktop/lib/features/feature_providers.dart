/// QAV-FLT-05: Feature data providers — learning, intake, entities, settings.
///
/// These replace the `_refreshFeatureData` catch-all in the god widget.
/// Each feature has its own provider so a failure in one does not block
/// the others, and so each can be refreshed independently.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api.dart';
import '../../core/providers.dart';
import '../../features/adapters.dart';
import '../../features/intake/state.dart' as intake;
import '../../features/learning/state.dart' as learning;
import '../../features/people/state.dart' as people;
import '../../features/settings/state.dart' as settings;

// ─── Learning ───────────────────────────────────────────────────────────

/// The learning state: open questions and whether the engine is on.
class LearningNotifier
    extends
        AsyncNotifier<
          ({bool enabled, List<learning.LearningPrompt> questions})
        > {
  @override
  Future<({bool enabled, List<learning.LearningPrompt> questions})>
  build() async {
    final api = ref.watch(vaultApiProvider);
    final result = await api.learning();
    final questions = result.questions
        .map(
          (q) => learning.LearningPrompt(
            id: '${q['id'] ?? ''}',
            prompt: '${q['question'] ?? ''}',
            why: q['context']?.toString() ?? '${q['trigger'] ?? ''}',
            trigger: '${q['trigger'] ?? ''}',
            novelty: (q['novelty_score'] as num?)?.toDouble() ?? 1,
          ),
        )
        .toList();
    return (enabled: result.enabled, questions: questions);
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);

  /// Optimistic toggle of the learning engine.
  Future<void> toggle(VaultApi api) async {
    final current = state.valueOrNull;
    if (current == null) return;
    final next = !current.enabled;
    state = AsyncData((enabled: next, questions: current.questions));
    try {
      await api.toggleLearning(next);
    } catch (_) {
      state = AsyncData((
        enabled: current.enabled,
        questions: current.questions,
      ));
    }
  }

  /// Add a new learning question (from SSE event).
  void addQuestion(learning.LearningPrompt question) {
    final current = state.valueOrNull;
    if (current == null) return;
    if (current.questions.any((q) => q.id == question.id)) return;
    state = AsyncData((
      enabled: current.enabled,
      questions: [question, ...current.questions],
    ));
  }

  /// Remove a learning question by id (from SSE event or user action).
  void removeQuestion(String id) {
    final current = state.valueOrNull;
    if (current == null) return;
    state = AsyncData((
      enabled: current.enabled,
      questions: current.questions.where((q) => q.id != id).toList(),
    ));
  }

  /// Answer a learning question via the API and remove it.
  Future<void> answerQuestion(VaultApi api, int id, String answer) async {
    await api.answerLearning(id, answer);
    removeQuestion('$id');
  }
}

final AsyncNotifierProvider<
  LearningNotifier,
  ({bool enabled, List<learning.LearningPrompt> questions})
>
learningProvider =
    AsyncNotifierProvider<
      LearningNotifier,
      ({bool enabled, List<learning.LearningPrompt> questions})
    >(LearningNotifier.new);

// ─── Intake ─────────────────────────────────────────────────────────────

class IntakeStatusNotifier extends AsyncNotifier<List<intake.IntakeItem>> {
  @override
  Future<List<intake.IntakeItem>> build() async {
    final api = ref.watch(vaultApiProvider);
    return api.featureIntakeStatus();
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<IntakeStatusNotifier, List<intake.IntakeItem>>
intakeStatusProvider =
    AsyncNotifierProvider<IntakeStatusNotifier, List<intake.IntakeItem>>(
      IntakeStatusNotifier.new,
    );

// ─── Entities ───────────────────────────────────────────────────────────

class EntitiesNotifier extends AsyncNotifier<List<people.EntitySummary>> {
  @override
  Future<List<people.EntitySummary>> build() async {
    final api = ref.watch(vaultApiProvider);
    return api.featureEntities();
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<EntitiesNotifier, List<people.EntitySummary>>
entitiesProvider =
    AsyncNotifierProvider<EntitiesNotifier, List<people.EntitySummary>>(
      EntitiesNotifier.new,
    );

// ─── Settings ───────────────────────────────────────────────────────────

class SettingsBundleNotifier
    extends
        AsyncNotifier<
          ({
            settings.AppSettings settings,
            settings.JurisdictionPack jurisdiction,
          })
        > {
  @override
  Future<
    ({settings.AppSettings settings, settings.JurisdictionPack jurisdiction})
  >
  build() async {
    final api = ref.watch(vaultApiProvider);
    return api.featureSettingsBundle();
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);

  /// Optimistic settings update with rollback on failure.
  Future<void> saveSettings(
    VaultApi api,
    settings.AppSettings before,
    settings.AppSettings after,
  ) async {
    final current = state.valueOrNull;
    if (current == null) return;
    state = AsyncData((settings: after, jurisdiction: current.jurisdiction));
    try {
      await api.saveFeatureSettings(before, after);
    } catch (_) {
      state = AsyncData((settings: before, jurisdiction: current.jurisdiction));
    }
  }
}

final AsyncNotifierProvider<
  SettingsBundleNotifier,
  ({settings.AppSettings settings, settings.JurisdictionPack jurisdiction})
>
settingsBundleProvider =
    AsyncNotifierProvider<
      SettingsBundleNotifier,
      ({settings.AppSettings settings, settings.JurisdictionPack jurisdiction})
    >(SettingsBundleNotifier.new);
