import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'test/_golden/advisory_comparator.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  final defaultComparator = goldenFileComparator;
  final testFile = defaultComparator is LocalFileComparator
      ? defaultComparator.basedir.resolve('runner.dart')
      : Uri.file('test/runner.dart');
  goldenFileComparator = AdvisoryGoldenComparator(testFile);
  await testMain();
}
