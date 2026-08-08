import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';

import '../theme.dart';

/// Drag-and-drop over the whole window — the Glaze orb's defining gesture,
/// carried into the desktop app. Files go straight to the daemon's P0 intake.
class VaultDropTarget extends StatefulWidget {
  final Widget child;
  final Future<void> Function(List<String> paths) onDrop;

  const VaultDropTarget({super.key, required this.child, required this.onDrop});

  @override
  State<VaultDropTarget> createState() => _VaultDropTargetState();
}

class _VaultDropTargetState extends State<VaultDropTarget> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) => DropTarget(
        onDragEntered: (_) => setState(() => _hovering = true),
        onDragExited: (_) => setState(() => _hovering = false),
        onDragDone: (detail) async {
          setState(() => _hovering = false);
          final paths = detail.files.map((f) => f.path).toList();
          if (paths.isNotEmpty) await widget.onDrop(paths);
        },
        child: Stack(children: [
          widget.child,
          if (_hovering)
            Positioned.fill(
              child: IgnorePointer(
                child: Container(
                  color: VaultColors.accent.withValues(alpha: 0.06),
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 18),
                      decoration: BoxDecoration(
                        color: VaultColors.panel,
                        border: Border.all(color: VaultColors.accent, width: 1.5),
                      ),
                      child: const Column(mainAxisSize: MainAxisSize.min, children: [
                        Text('Drop to file',
                            style: TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                                color: VaultColors.ink)),
                        SizedBox(height: 5),
                        Text('invoices · receipts · statements · screenshots',
                            style: TextStyle(fontSize: 11.5, color: VaultColors.faint)),
                      ]),
                    ),
                  ),
                ),
              ),
            ),
        ]),
      );
}
