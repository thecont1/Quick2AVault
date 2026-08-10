/// Typed client boundary for the adaptive-learning contract.
///
/// The daemon implementation lands separately; this feature intentionally owns
/// no learning state and only renders values supplied by that boundary.
library;

import 'state.dart';

abstract interface class LearningGateway {
  Future<List<LearningPrompt>> pendingQuestions();
  Future<void> answer(String questionId, String action, {String? value});
}
