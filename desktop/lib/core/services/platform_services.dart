/// Platform services — window management, menubar, screen retrieval.
///
/// These providers give feature code a single source for the services it
/// currently instantiates directly in main.dart. They are thin wrappers:
/// the behavior is unchanged, only the instantiation is centralized so
/// tests can override them.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../menubar.dart';
import '../../window_store.dart';

/// Provider for the [WindowStore] — persists the popup and full-window
/// geometry. Defaults to the on-disk location; tests override with an in-
/// memory store.
final Provider<WindowStore> windowStoreProvider =
    Provider<WindowStore>((ref) => WindowStore.defaultLocation());

/// A factory that builds a [MenubarController] given the callbacks it needs.
///
/// We provide a factory rather than the instance directly because the
/// menubar's lifecycle (init → show/hide) is owned by the shell, not by
/// a widget tree, and it needs closure-captured callbacks that the shell
/// owns. Tests substitute a fake factory.
typedef MenubarFactory = MenubarController Function({
  required VoidCallback onOpenFull,
  required VoidCallback onQuit,
  VoidCallback? onShowPopup,
  WindowStore? store,
});

/// Default factory — constructs the real [MenubarController].
MenubarController createMenubar({
  required VoidCallback onOpenFull,
  required VoidCallback onQuit,
  VoidCallback? onShowPopup,
  WindowStore? store,
}) =>
    MenubarController(
      onOpenFull: onOpenFull,
      onQuit: onQuit,
      onShowPopup: onShowPopup,
      store: store,
    );

final Provider<MenubarFactory> menubarFactoryProvider =
    Provider<MenubarFactory>((ref) => createMenubar);
