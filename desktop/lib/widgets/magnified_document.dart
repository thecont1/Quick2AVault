// A hover magnifier for document previews.
//
// Ported from the original React app's Preview component: while the pointer is
// over the document, a circular lens shows a 3x enlargement of the region under
// the cursor, so fine print (an invoice line item, a GST number, a date) can be
// read without opening the file in Preview.app or Acrobat.
//
// Implementation notes, because the coordinate maths is the whole difficulty:
//
//   * The image is laid out with BoxFit.contain, so it is letterboxed inside
//     its box. Pointer coordinates are in BOX space; the lens must sample in
//     IMAGE space. Mapping between the two is what makes the lens track the
//     thing under the cursor rather than drifting toward the edges.
//   * The lens is clamped so it never straddles the box edge, which would show
//     a half-empty circle at the margins.
//   * Nothing rebuilds during pointer movement except the lens itself: the
//     position lives in a ValueNotifier and only a ValueListenableBuilder
//     subscribes, so panning does not re-run the parent's build().
import 'package:flutter/widgets.dart';

import '../theme.dart';

/// How much the lens enlarges. Matches the React app's PREVIEW_ZOOM.
const double kLensZoom = 3.0;

/// Lens radius in logical pixels. Matches the React app's LENS_RADIUS.
const double kLensRadius = 80.0;

class MagnifiedDocument extends StatefulWidget {
  /// The image to display and magnify.
  final ImageProvider image;

  /// Shown instead of the lens when the image cannot be decoded (e.g. a PDF,
  /// which Flutter cannot rasterise without a plugin).
  final Widget? fallback;

  const MagnifiedDocument({super.key, required this.image, this.fallback});

  @override
  State<MagnifiedDocument> createState() => _MagnifiedDocumentState();
}

class _MagnifiedDocumentState extends State<MagnifiedDocument> {
  /// Pointer position in box space, or null when the pointer is outside.
  /// A ValueNotifier rather than setState: pointer moves fire at display rate
  /// and rebuilding the whole subtree each time drops frames on a large image.
  final _pos = ValueNotifier<Offset?>(null);

  /// Intrinsic image size, needed to compute the letterboxed rect. Resolved
  /// once the image stream delivers its first frame.
  Size? _intrinsic;
  Object? _error;
  ImageStream? _stream;
  ImageStreamListener? _listener;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _resolve();
  }

  @override
  void didUpdateWidget(MagnifiedDocument old) {
    super.didUpdateWidget(old);
    if (old.image != widget.image) {
      _intrinsic = null;
      _error = null;
      _resolve();
    }
  }

  void _resolve() {
    _detach();
    final stream = widget.image.resolve(createLocalImageConfiguration(context));
    final listener = ImageStreamListener(
      (info, _) {
        if (!mounted) return;
        setState(() {
          _intrinsic = Size(
            info.image.width.toDouble(),
            info.image.height.toDouble(),
          );
        });
      },
      // A PDF or an unsupported codec lands here. That is expected, not
      // exceptional: the caller supplies a fallback and the lens is disabled.
      onError: (e, _) {
        if (!mounted) return;
        setState(() => _error = e);
      },
    );
    stream.addListener(listener);
    _stream = stream;
    _listener = listener;
  }

  void _detach() {
    if (_stream != null && _listener != null) {
      _stream!.removeListener(_listener!);
    }
    _stream = null;
    _listener = null;
  }

  @override
  void dispose() {
    _detach();
    _pos.dispose();
    super.dispose();
  }

  /// The rect the image actually occupies inside [box] under BoxFit.contain.
  ///
  /// This is the crux: without it the lens samples container coordinates and
  /// the magnified region drifts away from the cursor wherever the image is
  /// letterboxed.
  Rect _imageRect(Size box) {
    final img = _intrinsic;
    if (img == null || img.isEmpty) return Rect.fromLTWH(0, 0, box.width, box.height);
    final scale = (box.width / img.width) < (box.height / img.height)
        ? box.width / img.width
        : box.height / img.height;
    final w = img.width * scale;
    final h = img.height * scale;
    return Rect.fromLTWH((box.width - w) / 2, (box.height - h) / 2, w, h);
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null && widget.fallback != null) return widget.fallback!;

    return LayoutBuilder(
      builder: (context, constraints) {
        final box = Size(constraints.maxWidth, constraints.maxHeight);
        final canZoom = _intrinsic != null && _error == null;

        return MouseRegion(
          cursor: canZoom
              ? SystemMouseCursors.zoomIn
              : MouseCursor.defer,
          onExit: (_) => _pos.value = null,
          onHover: (e) {
            if (!canZoom) return;
            _pos.value = e.localPosition;
          },
          child: Stack(
            fit: StackFit.expand,
            children: [
              Image(image: widget.image, fit: BoxFit.contain),
              if (canZoom)
                ValueListenableBuilder<Offset?>(
                  valueListenable: _pos,
                  builder: (context, pos, _) {
                    if (pos == null) return const SizedBox.shrink();
                    return _Lens(
                      image: widget.image,
                      pointer: pos,
                      box: box,
                      imageRect: _imageRect(box),
                    );
                  },
                ),
            ],
          ),
        );
      },
    );
  }
}

/// The circular magnified window itself.
class _Lens extends StatelessWidget {
  final ImageProvider image;
  final Offset pointer;
  final Size box;
  final Rect imageRect;

  const _Lens({
    required this.image,
    required this.pointer,
    required this.box,
    required this.imageRect,
  });

  @override
  Widget build(BuildContext context) {
    // Keep the whole lens inside the box so it is never a clipped half-circle.
    final cx = pointer.dx.clamp(kLensRadius, box.width - kLensRadius);
    final cy = pointer.dy.clamp(kLensRadius, box.height - kLensRadius);

    // Where the cursor sits within the IMAGE, not the box. Sampling in box
    // space is the classic bug here: the lens appears to lag toward the centre
    // whenever the image is letterboxed.
    final inImage = Offset(pointer.dx - imageRect.left, pointer.dy - imageRect.top);

    // The enlarged image is imageRect * zoom; offset it so the point under the
    // cursor lands at the lens centre.
    final scaled = Size(imageRect.width * kLensZoom, imageRect.height * kLensZoom);
    final dx = kLensRadius - inImage.dx * kLensZoom;
    final dy = kLensRadius - inImage.dy * kLensZoom;

    return Positioned(
      left: cx - kLensRadius,
      top: cy - kLensRadius,
      width: kLensRadius * 2,
      height: kLensRadius * 2,
      child: IgnorePointer(
        child: ClipOval(
          child: DecoratedBox(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: VaultColors.panel,
              border: Border.all(color: VaultColors.accent, width: 3),
            ),
            child: ClipOval(
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Positioned(
                    left: dx,
                    top: dy,
                    width: scaled.width,
                    height: scaled.height,
                    child: Image(
                      image: image,
                      fit: BoxFit.fill,
                      // Nearest-neighbour would look crunchy; the point is to
                      // read small type, so smooth upscaling wins.
                      filterQuality: FilterQuality.high,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
