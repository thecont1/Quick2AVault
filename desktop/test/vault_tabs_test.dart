// One window, one place for everything.
//
// The bug that motivated this: Settings / Document Review / People were three
// mutually-exclusive booleans, and onReview and onSetup BOTH set _setup — so
// the Document Review button opened Settings. Three booleans encode eight
// states, only four of which are valid. An enum makes the invalid ones
// unrepresentable, which is why this refactor is a correctness fix and not
// just a layout change.
import 'package:flutter/material.dart';
import 'dart:ui' show Tristate;
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/widgets/vault_tabs.dart';

Widget _bar({
  VaultTab current = VaultTab.ledger,
  ValueChanged<VaultTab>? onChanged,
  int reviewCount = 0,
  Set<VaultTab> disabled = const {},
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 1360,
      child: VaultTabBar(
        current: current,
        onChanged: onChanged ?? (_) {},
        reviewCount: reviewCount,
        disabled: disabled,
      ),
    ),
  ),
);

void main() {
  testWidgets('every surface is reachable from the tab bar', (tester) async {
    await tester.pumpWidget(_bar());
    await tester.pumpAndSettle();

    // The point of the refactor: nothing is hidden behind the popup.
    for (final t in VaultTab.values) {
      expect(
        find.text(t.label),
        findsOneWidget,
        reason: '${t.label} must be reachable from the full window',
      );
    }
  });

  testWidgets('tapping a tab reports THAT tab', (tester) async {
    // The original bug in one assertion: Review must not report Settings.
    final picked = <VaultTab>[];
    await tester.pumpWidget(_bar(onChanged: picked.add));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Review'));
    await tester.tap(find.text('Settings'));
    await tester.tap(find.text('People'));
    await tester.pumpAndSettle();

    expect(picked, [VaultTab.review, VaultTab.settings, VaultTab.people]);
  });

  testWidgets('a disabled tab does not fire', (tester) async {
    final picked = <VaultTab>[];
    await tester.pumpWidget(
      _bar(onChanged: picked.add, disabled: const {VaultTab.charts}),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Charts'));
    await tester.pumpAndSettle();
    expect(picked, isEmpty, reason: 'Charts is not built yet');

    // But it is still VISIBLE — a greyed tab is an honest promise, a missing
    // one is a surprise when it appears later.
    expect(find.text('Charts'), findsOneWidget);
  });

  testWidgets('the review badge shows the pending count', (tester) async {
    await tester.pumpWidget(_bar(reviewCount: 3));
    await tester.pumpAndSettle();
    expect(find.text('3'), findsOneWidget);
  });

  testWidgets('no badge when the queue is empty', (tester) async {
    // A "0" badge is noise that trains the user to ignore the indicator.
    await tester.pumpWidget(_bar(reviewCount: 0));
    await tester.pumpAndSettle();
    expect(find.text('0'), findsNothing);
  });

  testWidgets('the current tab is announced as selected', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_bar(current: VaultTab.people));
    await tester.pumpAndSettle();

    final node = tester.getSemantics(find.text('People'));
    expect(node.flagsCollection.isSelected, Tristate.isTrue);

    final other = tester.getSemantics(find.text('Ledger'));
    expect(other.flagsCollection.isSelected, Tristate.isFalse);
    handle.dispose();
  });

  testWidgets('a disabled tab is announced as disabled', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_bar(disabled: const {VaultTab.charts}));
    await tester.pumpAndSettle();

    final node = tester.getSemantics(find.text('Charts'));
    expect(node.flagsCollection.isEnabled, Tristate.isFalse);
    handle.dispose();
  });

  test('the tab enum covers every surface exactly once', () {
    // Guards against a tab being added to the enum but never given a body, or
    // two enum entries sharing a label (which would make the bar ambiguous).
    final labels = VaultTab.values.map((t) => t.label).toList();
    expect(labels.toSet().length, labels.length, reason: 'duplicate tab label');
    // Work order 06 added the Intake tab (Irrelevant view + intake feed).
    expect(VaultTab.values.length, 6);
  });

  test('Ledger is the first tab, and therefore the default surface', () {
    // The window must open on the ledger. Opening on Review (or anything else)
    // buries the numbers behind a queue that is usually empty, and the tab
    // order is what communicates primacy.
    expect(VaultTab.values.first, VaultTab.ledger);
  });
}
