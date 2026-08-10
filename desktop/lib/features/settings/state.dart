class AppSettings {
  final bool learningEnabled;

  /// null means adaptive automatic budget; otherwise this is the manual cap.
  final int? questionBudget;
  final bool watcherEnabled;
  final bool scanOnLaunch;
  final bool moveOnSuccess;
  final String? dropFolder;

  const AppSettings({
    required this.learningEnabled,
    required this.questionBudget,
    this.watcherEnabled = true,
    this.scanOnLaunch = true,
    this.moveOnSuccess = true,
    this.dropFolder,
  });

  factory AppSettings.fromJson(Map<String, dynamic> json) {
    final learning =
        (json['learning'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final intake =
        (json['intake'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final vault =
        (json['vault'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    return AppSettings(
      learningEnabled: _bool(
        learning['enabled'] ?? json['learning.enabled'],
        fallback: true,
      ),
      questionBudget: _int(
        learning['question_budget'] ?? json['learning.question_budget'],
      ),
      watcherEnabled: _bool(
        intake['watcher_enabled'] ?? json['intake.watcher_enabled'],
        fallback: true,
      ),
      scanOnLaunch: _bool(
        intake['scan_on_launch'] ?? json['intake.scan_on_launch'],
        fallback: true,
      ),
      moveOnSuccess: _bool(
        intake['move_on_success'] ?? json['intake.move_on_success'],
        fallback: true,
      ),
      dropFolder:
          (intake['drop_folder'] ?? json['intake.drop_folder'] ?? vault['drop'])
              ?.toString(),
    );
  }

  Map<String, dynamic> toJson() => {
    'learning_enabled': learningEnabled,
    'question_budget': questionBudget,
    'watcher_enabled': watcherEnabled,
    'scan_on_launch': scanOnLaunch,
    'move_on_success': moveOnSuccess,
    if (dropFolder != null) 'drop_folder': dropFolder,
  };

  AppSettings copyWith({
    bool? learningEnabled,
    int? questionBudget,
    bool clearBudget = false,
    bool? watcherEnabled,
    bool? scanOnLaunch,
    bool? moveOnSuccess,
    String? dropFolder,
    bool clearDropFolder = false,
  }) => AppSettings(
    learningEnabled: learningEnabled ?? this.learningEnabled,
    questionBudget: clearBudget ? null : questionBudget ?? this.questionBudget,
    watcherEnabled: watcherEnabled ?? this.watcherEnabled,
    scanOnLaunch: scanOnLaunch ?? this.scanOnLaunch,
    moveOnSuccess: moveOnSuccess ?? this.moveOnSuccess,
    dropFolder: clearDropFolder ? null : dropFolder ?? this.dropFolder,
  );

  static bool _bool(Object? value, {required bool fallback}) => switch (value) {
    bool v => v,
    String v => v.toLowerCase() == 'true',
    num v => v != 0,
    _ => fallback,
  };

  static int? _int(Object? value) => switch (value) {
    int v => v,
    num v => v.toInt(),
    String v => int.tryParse(v),
    _ => null,
  };
}

class JurisdictionPack {
  final String id;
  final String name;
  final String version;
  final String currency;
  final int financialYearStartMonth;
  final String? financialYearLabel;

  const JurisdictionPack({
    required this.id,
    required this.name,
    required this.version,
    required this.currency,
    required this.financialYearStartMonth,
    this.financialYearLabel,
  });

  static const india = JurisdictionPack(
    id: 'in',
    name: 'India',
    version: 'built-in',
    currency: 'INR',
    financialYearStartMonth: 4,
    financialYearLabel: 'Financial year starts in April',
  );

  factory JurisdictionPack.fromJson(Map<String, dynamic> json) =>
      JurisdictionPack(
        id: (json['id'] ?? '').toString(),
        name: (json['name'] ?? 'Unknown pack').toString(),
        version: (json['version'] ?? '').toString(),
        currency: (json['currency'] ?? '').toString(),
        financialYearStartMonth: (json['fy_start_month'] as num?)?.toInt() ?? 1,
        financialYearLabel: json['fy_label']?.toString(),
      );
}
