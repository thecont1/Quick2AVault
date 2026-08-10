import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/popup_view.dart';
import 'package:quick2avault_desktop/widgets/period_bar.dart';
import 'package:quick2avault_desktop/widgets/treemap.dart';

TreemapNode _n(String id, String label, int minor) => TreemapNode(
      id: id, label: label, amountMinor: minor, transactions: 1, known: true, sources: const [],
    );

void main() {
  testWidgets('TreemapBand appears between Spending and Investments when data is present', (tester) async {
    final treemap = TreemapData(
      nodes: [_n('food', 'Food', 50000), _n('transport', 'Transport', 30000)],
      totalMinor: 80000,
      rawBuckets: 2,
    );
    await tester.pumpWidget(MaterialApp(
      home: SizedBox(
        width: 420,
        height: 760,
        child: PopupView(
          snapshot: Snapshot.empty,
          periods: Periods.empty,
          selection: PeriodSelection.thisMonth,
          onPeriodChanged: (_) {},
          txns: const [],
          feed: const [],
          connected: true,
          onOpenFull: () {},
          onQuit: () {},
          onSetup: () {},
          onReview: () {},
          onRefresh: () {},
          onToggleLearning: () {},
          treemap: treemap,
        ),
      ),
    ));

    // The TreemapBand should be rendered.
    expect(find.byType(TreemapBand), findsOneWidget);

    // The band should be between Spending and Investments.
    final spendingText = find.text('Spending');
    final investmentsText = find.text('Investments');
    final band = find.byType(TreemapBand);

    expect(spendingText, findsOneWidget);
    expect(investmentsText, findsOneWidget);

    final spendingY = tester.getCenter(spendingText).dy;
    final bandY = tester.getCenter(band).dy;
    final investmentsY = tester.getCenter(investmentsText).dy;

    expect(spendingY, lessThan(bandY), reason: 'Spending should be above the band');
    expect(bandY, lessThan(investmentsY), reason: 'Band should be above Investments');
  });

  testWidgets('TreemapBand does not appear when treemap is empty', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: SizedBox(
        width: 420,
        height: 760,
        child: PopupView(
          snapshot: Snapshot.empty,
          periods: Periods.empty,
          selection: PeriodSelection.thisMonth,
          onPeriodChanged: (_) {},
          txns: const [],
          feed: const [],
          connected: true,
          onOpenFull: () {},
          onQuit: () {},
          onSetup: () {},
          onReview: () {},
          onRefresh: () {},
          onToggleLearning: () {},
          treemap: TreemapData.empty,
        ),
      ),
    ));

    expect(find.byType(TreemapBand), findsNothing);
  });
}
