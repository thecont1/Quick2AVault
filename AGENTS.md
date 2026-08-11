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
- `lib/main.dart` — App entry point and VaultHome shell (provider-driven)
- `lib/features/events/event_dispatcher.dart` — SSE event dispatch to providers

### Configuration

- `build.yaml` — json_serializable config (snake_case field rename, explicit_to_json)
- `analysis_options.yaml` — Lint rules, ignores invalid_annotation_target (Freezed)

### HTTP dependency boundary

Dio is the production HTTP client. `package:http` remains temporarily because
`HttpClienDioAdapter` (in `lib/core/network/http_client_adapter.dart`) preserves
existing `MockClient`-based tests. New production code must not import
`package:http` directly. Removal is tracked as a follow-up ticket:
> `test(desktop): migrate MockClient tests to Dio test transport and remove http`

The boundary is enforced:
- `lib/api.dart` is the only production file that imports `package:http` (for the adapter).
- All other `package:http` usage is in `test/` files using `MockClient`.
- Feature widgets and providers do not import `package:http`.

## CI

GitHub Actions workflow in `.github/workflows/flutter.yml` runs:
1. `flutter pub get`
2. `dart run build_runner build --delete-conflicting-outputs`
3. `flutter analyze`
4. `flutter test`

## macOS smoke test checklist

Before tagging a release or merging a major refactor, run these manual checks
against a real daemon and a release-built macOS app:

```bash
cd desktop && flutter build macos --dart-define=Q2AV_URL=http://127.0.0.1:4477 --dart-define=Q2AV_TOKEN=<token>
```

- [ ] **Cold start**: launch from a clean state; verify the menubar popup appears
- [ ] **Connection status**: the status dot shows "live" once the daemon responds
- [ ] **Period change**: switch the period; dashboard figures update exactly once
- [ ] **Receipts bucket**: switch the bucket; the receipts list and evidence panel reset
- [ ] **Settings round-trip**: open Settings, toggle learning, close and reopen — the toggle persists
- [ ] **API key save/clear**: set a key, clear it, verify the wire payload (empty string, not dropped)
- [ ] **Daemon restart**: stop the daemon, verify "reconnecting" then "live" on restart; figures refresh
- [ ] **SSE recovery**: after daemon restart, no duplicate event handling or duplicate requests
- [ ] **Drag-and-drop**: drop a file onto the window; verify it ingests
- [ ] **Document detail**: open a transaction, exercise evidence panel and review actions
- [ ] **Window restoration**: close the full window, reopen from tray; geometry is remembered
- [ ] **Release logging**: no tokens, API keys, or document contents appear in console output
- [ ] **Entitlements**: the sandboxed release app can reach 127.0.0.1 and read dropped files
