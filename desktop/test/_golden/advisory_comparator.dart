// Layer 2 golden comparator: reports visual drift without blocking CI.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

class AdvisoryGoldenComparator extends LocalFileComparator {
  AdvisoryGoldenComparator(
    super.testFile, {
    this.toleranceFraction = defaultToleranceFraction,
  }) : assert(toleranceFraction >= 0 && toleranceFraction <= 1);

  static const double defaultToleranceFraction = 0.005;
  final double toleranceFraction;

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    ComparisonResult? result;
    Object? comparisonError;
    try {
      result = await GoldenFileComparator.compareLists(
        imageBytes,
        await getGoldenBytes(golden),
      );
    } catch (error) {
      comparisonError = error;
    }

    final diffFraction = result?.diffPercent;
    final withinTolerance =
        diffFraction != null && diffFraction <= toleranceFraction;
    await _writeReport(
      golden,
      diffFraction: diffFraction,
      exactMatch: result?.passed ?? false,
      withinTolerance: withinTolerance,
      error: comparisonError ?? result?.error,
    );
    result?.dispose();

    // Layer 1 widget assertions are fail-closed. Layer 2 is always advisory.
    return true;
  }

  Future<void> _writeReport(
    Uri golden, {
    required double? diffFraction,
    required bool exactMatch,
    required bool withinTolerance,
    Object? error,
  }) async {
    final reportDir = Directory('test/_golden/reports');
    await reportDir.create(recursive: true);
    final report = File('${reportDir.path}/${golden.pathSegments.last}.txt');
    final status = exactMatch || withinTolerance
        ? 'within tolerance'
        : 'review requested';
    await report.writeAsString(
      <String>[
        'Golden: ${golden.toFilePath()}',
        'Tolerance: ${(toleranceFraction * 100).toStringAsFixed(4)}%',
        'Diff fraction: ${diffFraction == null ? 'unavailable' : '${(diffFraction * 100).toStringAsFixed(4)}%'}',
        'Exact match: $exactMatch',
        'Within tolerance: $withinTolerance',
        'Status: $status',
        if (error != null) 'Comparison error: $error',
        if (!exactMatch && !withinTolerance)
          'ADVISORY: review the visual change; fix a regression or update the golden deliberately.',
      ].join('\n'),
    );
  }
}
