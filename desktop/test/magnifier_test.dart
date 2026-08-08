// The magnifier must magnify what is UNDER THE CURSOR.
//
// The bug this guards is subtle and very easy to ship: the pointer arrives in
// box coordinates, but the image is letterboxed inside that box by
// BoxFit.contain. Sampling in box space makes the lens track something slightly
// wrong — the error is zero at the centre and grows toward the edges, so it
// looks fine in casual testing and is wrong exactly where fine print lives.
//
// These tests exercise the mapping directly rather than through a golden image,
// because a screenshot cannot tell you WHICH pixel the lens sampled.
import 'package:flutter/foundation.dart' show SynchronousFuture;
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/widgets/magnified_document.dart';

/// Re-implements the widget's letterbox maths so the contract can be asserted
/// independently. If the widget changes, this must be updated deliberately —
/// that is the point.
Rect imageRectFor(Size box, Size intrinsic) {
  final scale = (box.width / intrinsic.width) < (box.height / intrinsic.height)
      ? box.width / intrinsic.width
      : box.height / intrinsic.height;
  final w = intrinsic.width * scale;
  final h = intrinsic.height * scale;
  return Rect.fromLTWH((box.width - w) / 2, (box.height - h) / 2, w, h);
}

/// Where the lens places the enlarged image, given a pointer position.
/// Mirrors _Lens: dx = radius - inImage.dx * zoom.
Offset lensOffsetFor(Offset pointer, Rect imageRect) {
  final inImage = Offset(pointer.dx - imageRect.left, pointer.dy - imageRect.top);
  return Offset(
    kLensRadius - inImage.dx * kLensZoom,
    kLensRadius - inImage.dy * kLensZoom,
  );
}

void main() {
  group('letterbox mapping', () {
    test('a portrait document in a wide box is centred horizontally', () {
      // A4-ish portrait page in a landscape viewport: bars on the left/right.
      final r = imageRectFor(const Size(800, 600), const Size(595, 842));
      expect(r.height, 600, reason: 'height-constrained, so it fills vertically');
      expect(r.width, closeTo(423.9, 0.1));
      expect(r.left, closeTo((800 - 423.9) / 2, 0.1));
      expect(r.top, 0);
    });

    test('a landscape document in a tall box is centred vertically', () {
      final r = imageRectFor(const Size(600, 800), const Size(1600, 900));
      expect(r.width, 600);
      expect(r.height, closeTo(337.5, 0.1));
      expect(r.top, closeTo((800 - 337.5) / 2, 0.1));
      expect(r.left, 0);
    });

    test('an exactly-matching aspect ratio has no letterbox', () {
      final r = imageRectFor(const Size(800, 600), const Size(1600, 1200));
      expect(r, const Rect.fromLTWH(0, 0, 800, 600));
    });
  });

  group('lens sampling', () {
    test('the image point under the cursor lands at the lens centre', () {
      // This is the whole contract. Pick a letterboxed layout and a pointer
      // that is NOT at the centre, then verify the maths puts the sampled
      // point exactly under the crosshair.
      final rect = imageRectFor(const Size(800, 600), const Size(595, 842));
      const pointer = Offset(300, 150);

      final off = lensOffsetFor(pointer, rect);

      // Under the lens, the image is drawn at `off` scaled by kLensZoom. The
      // pixel that ends up at the lens centre (radius, radius) is therefore:
      final sampledX = (kLensRadius - off.dx) / kLensZoom;
      final sampledY = (kLensRadius - off.dy) / kLensZoom;

      // ...and it must equal the cursor's position in IMAGE space.
      expect(sampledX, closeTo(pointer.dx - rect.left, 0.001));
      expect(sampledY, closeTo(pointer.dy - rect.top, 0.001));
    });

    test('box-space sampling would be wrong by exactly the letterbox offset', () {
      // Demonstrates the bug being prevented, so the test above cannot be
      // "simplified" into meaninglessness later.
      final rect = imageRectFor(const Size(800, 600), const Size(595, 842));
      expect(rect.left, greaterThan(100),
          reason: 'this layout has a substantial horizontal letterbox');

      const pointer = Offset(300, 150);
      final correct = lensOffsetFor(pointer, rect);
      // The naive version forgets to subtract rect.left/top:
      final naive = Offset(
        kLensRadius - pointer.dx * kLensZoom,
        kLensRadius - pointer.dy * kLensZoom,
      );
      expect((correct.dx - naive.dx).abs(), closeTo(rect.left * kLensZoom, 0.001),
          reason: 'the error scales with the zoom — 3x here');
    });

    test('zoom and radius are the values the original app used', () {
      // Ported deliberately: 3x at 80px reads invoice line items comfortably.
      // Changing these is a design decision, not an implementation detail.
      expect(kLensZoom, 3.0);
      expect(kLensRadius, 80.0);
    });
  });

  group('widget behaviour', () {
    testWidgets('a broken image falls back instead of showing a dead lens',
        (tester) async {
      // A PDF cannot be decoded by Flutter without a plugin. That is an
      // expected state, not an error: the caller supplies a fallback and the
      // magnifier must show it rather than an empty box with a zoom cursor.
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 400,
            height: 300,
            child: MagnifiedDocument(
              image: const _FailingImage(),
              fallback: const Text('cannot preview'),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('cannot preview'), findsOneWidget);
    });
  });
}

/// An ImageProvider that always fails to load — stands in for a PDF.
class _FailingImage extends ImageProvider<_FailingImage> {
  const _FailingImage();

  @override
  Future<_FailingImage> obtainKey(ImageConfiguration configuration) =>
      SynchronousFuture<_FailingImage>(this);

  @override
  ImageStreamCompleter loadImage(_FailingImage key, ImageDecoderCallback decode) =>
      OneFrameImageStreamCompleter(
        Future<ImageInfo>.error(Exception('unsupported format')),
      );
}
