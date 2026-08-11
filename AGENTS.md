# Quick2AVault — Flutter Desktop Client

## Project structure

- `desktop/` — Flutter macOS desktop client (the active work area)
- `daemon/` — Node.js daemon (the backend the Flutter app connects to)
- The Flutter app is a pure client of the daemon API. No database, no business logic.

## Build and development

All commands run from `desktop/`.

### Install dependencies
```bash
cd desktop && flutter pub get
```

### Code generation (Freezed + json_serializable + riverpod_generator)
```bash
cd desktop && dart run build_runner build --delete-conflicting-outputs
```
Generated files (`*.freezed.dart`, `*.g.dart`) are gitignored and must be
regenerated after checkout. CI runs this step.

### Analyze
```bash
cd desktop && flutter analyze
```

### Test
```bash
cd desktop && flutter test
```

Note: `test/settings_click_through_test.dart` is flaky due to an SSE
teardown issue. Exclude it with:
```bash
cd desktop && flutter test $(find test -name "*_test.dart" ! -name "settings_click_through_test.dart")
```

### Build macOS
```bash
cd desktop && flutter build macos
```

### Run with daemon connection
```bash
cd desktop && flutter run --dart-define=Q2AV_URL=http://127.0.0.1:4477 --dart-define=Q2AV_TOKEN=<token>
```

## Architecture (QAV-FLT refactor)

The Flutter app uses established Dart/Flutter packages:

| Package | Role |
|---------|------|
| `dio` | HTTP client for daemon API |
| `freezed` / `freezed_annotation` | Immutable generated models |
| `json_serializable` / `json_annotation` | JSON serialization for models |
| `flutter_riverpod` / `riverpod_annotation` | State management and DI |
| `logger` | Privacy-safe logging |
| `build_runner` | Code generation runner |
| `riverpod_generator` | Riverpod provider code generation |

### Key files

- `lib/api.dart` — VaultApi client (Dio-based), re-exports models
- `lib/models.dart` — Freezed-generated immutable API models
- `lib/core/providers.dart` — DI barrel (AppConfig, Dio, Logger, VaultApi)
- `lib/core/utils/money.dart` — Currency formatting helpers
- `lib/features/connection/status_provider.dart` — Daemon connection state
- `lib/features/dashboard/` — Snapshot, treemap, transactions, periods providers
- `lib/features/events/event_service.dart` — SSE EventService with reconnection
- `lib/features/feature_providers.dart` — Learning, intake, entities, settings
- `lib/main.dart` — App entry point and god widget (being migrated)

### Configuration

- `build.yaml` — json_serializable config (snake_case field rename, explicit_to_json)
- `analysis_options.yaml` — Lint rules, ignores invalid_annotation_target (Freezed)

## CI

GitHub Actions workflow in `.github/workflows/flutter.yml` runs:
1. `flutter pub get`
2. `dart run build_runner build --delete-conflicting-outputs`
3. `flutter analyze`
4. `flutter test`
