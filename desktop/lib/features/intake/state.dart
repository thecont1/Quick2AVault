import '../people/state.dart';

enum PipelineState {
  received,
  stable,
  hashed,
  triaged,
  converting,
  analysing,
  complete,
  failed,
  duplicate,
  irrelevant,
  passwordNeeded,
}

extension PipelineStateLabel on PipelineState {
  String get label => switch (this) {
    PipelineState.passwordNeeded => 'Password needed',
    PipelineState.complete => 'Complete',
    PipelineState.failed => 'Failed',
    PipelineState.duplicate => 'Duplicate',
    PipelineState.irrelevant => 'Irrelevant',
    _ => name[0].toUpperCase() + name.substring(1),
  };
  bool get terminal => switch (this) {
    PipelineState.complete ||
    PipelineState.failed ||
    PipelineState.duplicate ||
    PipelineState.irrelevant ||
    PipelineState.passwordNeeded => true,
    _ => false,
  };
}

class IntakeItem {
  final String id;
  final int? intakeId;
  final String filename;
  final String entity;
  final EntityKind entityKind;
  final PipelineState state;
  final String source;
  final DateTime date;
  final String? reason;
  final String? sourcePath;
  final String? documentId;
  const IntakeItem({
    required this.id,
    this.intakeId,
    required this.filename,
    required this.entity,
    required this.entityKind,
    required this.state,
    required this.source,
    required this.date,
    this.reason,
    this.sourcePath,
    this.documentId,
  });
}
