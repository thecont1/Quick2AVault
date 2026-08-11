# Core infrastructure

This directory holds the application's shared infrastructure — the DI
boundary that sits between the platform layer and feature code.

## Layout

| Path                         | Responsibility |
|---|---|
| `config/app_config.dart`     | AppConfig + appConfigProvider — reads `--dart-define` for base URL and token. |
| `logging/app_logger.dart`    | createLogger() + appLoggerProvider — structured logger with privacy redaction. |
| `network/dio_client.dart`    | createDio() + dioProvider — centrally configured Dio client. |
| `services/platform_services.dart` | windowStoreProvider, menubarFactoryProvider — window/menubar services. |
| `providers.dart`              | Barrel export — the single import features use. |

## Migration status

- QAV-FLT-02 (this ticket): `ProviderScope` is the root, core providers exist.
  `main.dart` still instantiates `VaultApi` directly — that migrates in QAV-FLT-03.
- QAV-FLT-03: all daemon calls move to the Dio client.
- QAV-FLT-05: feature state moves to Riverpod notifiers.

## Generated files

`build_runner` outputs `.freezed.dart` and `.g.dart` files alongside their
sources. These are **git-ignored** and regenerated in CI via:

```sh
cd desktop && dart run build_runner build --delete-conflicting-outputs
```
