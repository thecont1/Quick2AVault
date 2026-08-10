/// Work order 07 §F — Dart-side bridge to the native NSStatusItem + NSPopover.
///
/// On macOS, the menubar popover is a native NSPopover anchored to an
/// NSStatusItem, implemented in PopoverPlugin.swift. This class is the
/// Dart-side platform channel that calls into that plugin.
///
/// The native popover hosts the main FlutterViewController (moved from the
/// main window), so the Dart widget tree is shared between the popover and
/// the full window. The Dart side is responsible for switching between the
/// compact popover layout and the full vault layout.
library;

import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/services.dart';

/// The popover mode the app is in.
enum PopoverMode {
  /// Compact menubar popover (420x760 equivalent).
  popover,
  /// Full resizable vault window.
  full,
  /// Hidden — no surface visible.
  hidden,
}

/// Callbacks from the native popover lifecycle.
typedef PopoverLifecycleCallback = void Function(PopoverMode mode);

class PopoverBridge {
  static const _channel = MethodChannel('quick2avault/popover');

  PopoverLifecycleCallback? onModeChanged;

  bool _supported = false;
  bool _initialized = false;

  /// True on macOS where the native popover plugin is available.
  bool get isSupported => _supported;

  PopoverBridge() {
    _supported = Platform.isMacOS;
    if (_supported) {
      _channel.setMethodCallHandler(_handleMethodCall);
    }
  }

  Future<dynamic> _handleMethodCall(MethodCall call) async {
    switch (call.method) {
      case 'onPopoverWillShow':
        // The native side is about to show the popover. Switch to the
        // compact layout before the FlutterViewController is moved.
        onModeChanged?.call(PopoverMode.popover);
        break;
      case 'onPopoverClosed':
        // The popover was dismissed (transient behavior — click outside).
        // The FlutterViewController has been restored to the main window,
        // which is hidden. The app is back in the menubar.
        onModeChanged?.call(PopoverMode.hidden);
        break;
    }
    return null;
  }

  /// Install the NSStatusItem in the menubar. Call once at startup.
  Future<void> installStatusItem() async {
    if (!_supported) return;
    try {
      await _channel.invokeMethod('installStatusItem');
      _initialized = true;
    } catch (e) {
      // The native plugin may not be available in tests or on non-macOS.
      _supported = false;
    }
  }

  /// Show the popover. The Dart side should switch to the compact layout
  /// before calling this (or in response to onModeChanged).
  Future<bool> showPopover() async {
    if (!_supported) return false;
    try {
      return await _channel.invokeMethod('showPopover') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Hide the popover.
  Future<void> hidePopover() async {
    if (!_supported) return;
    try {
      await _channel.invokeMethod('hidePopover');
    } catch (_) {/* best-effort */}
  }

  /// Toggle the popover visibility.
  Future<bool> togglePopover() async {
    if (!_supported) return false;
    try {
      return await _channel.invokeMethod('togglePopover') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Show the full vault window. Closes the popover and restores the
  /// FlutterViewController to the main window.
  Future<bool> showFullWindow() async {
    if (!_supported) return false;
    try {
      final result = await _channel.invokeMethod('showFullWindow') ?? false;
      if (result) {
        onModeChanged?.call(PopoverMode.full);
      }
      return result;
    } catch (_) {
      return false;
    }
  }

  /// True if the popover is currently shown.
  Future<bool> isPopoverShown() async {
    if (!_supported) return false;
    try {
      return await _channel.invokeMethod('isPopoverShown') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Clean up the status item and popover.
  Future<void> dispose() async {
    if (!_supported) return;
    try {
      await _channel.invokeMethod('dispose');
    } catch (_) {/* best-effort */}
  }
}
