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
    extends AsyncNotifier<({bool enabled, List<learning.LearningPrompt> questions})> {
  @override
  Future<({bool enabled, List<learning.LearningPrompt> questions})> build() async {
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
}

final AsyncNotifierProvider<LearningNotifier,
    ({bool enabled, List<learning.LearningPrompt> questions})> learningProvider =
    AsyncNotifierProvider<LearningNotifier,
        ({bool enabled, List<learning.LearningPrompt> questions})>(
  LearningNotifier.new,
);

// ─── Intake ─────────────────────────────────────────────────────────────

class IntakeStatusNotifier extends AsyncNotifier<List<intake.IntakeItem>> {
  @override
  Future<List<intake.IntakeItem>> build() async {
    final api = ref.watch(vaultApiProvider);
    return api.featureIntakeStatus();
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<IntakeStatusNotifier,
    List<intake.IntakeItem>> intakeStatusProvider =
    AsyncNotifierProvider<IntakeStatusNotifier,
        List<intake.IntakeItem>>(
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

final AsyncNotifierProvider<EntitiesNotifier,
    List<people.EntitySummary>> entitiesProvider =
    AsyncNotifierProvider<EntitiesNotifier,
        List<people.EntitySummary>>(
  EntitiesNotifier.new,
);

// ─── Settings ───────────────────────────────────────────────────────────

class SettingsBundleNotifier
    extends AsyncNotifier<({settings.AppSettings settings, settings.JurisdictionPack jurisdiction})> {
  @override
  Future<({settings.AppSettings settings, settings.JurisdictionPack jurisdiction})>
      build() async {
    final api = ref.watch(vaultApiProvider);
    return api.featureSettingsBundle();
  }

  Future<void> refresh() async => state = await AsyncValue.guard(build);
}

final AsyncNotifierProvider<SettingsBundleNotifier,
    ({settings.AppSettings settings, settings.JurisdictionPack jurisdiction})>
    settingsBundleProvider =
    AsyncNotifierProvider<SettingsBundleNotifier,
        ({settings.AppSettings settings, settings.JurisdictionPack jurisdiction})>(
  SettingsBundleNotifier.new,
);
