import 'package:flutter_test/flutter_test.dart';

import 'advisory_comparator.dart';

void installAdvisoryGoldenComparator(Uri testFile) {
  goldenFileComparator = AdvisoryGoldenComparator(testFile);
}
