class LearningPrompt {
  final String id;
  final String prompt;
  final String why;
  final String trigger;
  final double novelty;

  const LearningPrompt({
    required this.id,
    required this.prompt,
    required this.why,
    required this.trigger,
    required this.novelty,
  });
}
