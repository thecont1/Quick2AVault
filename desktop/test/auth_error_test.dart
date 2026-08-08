// An auth failure must never render as "your vault is empty".
//
// The bug this guards: _refresh() swallowed every exception with `catch (_)`,
// so a 401 left _snap at Snapshot.empty and the UI displayed Rs 0 for every
// total. The user read that as catastrophic data loss — reasonably, because
// Rs 0 across the board is exactly what an emptied vault looks like. Zero is
// a legitimate value; "I could not read your vault" is not zero.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/popup_view.dart';
import 'package:quick2avault_desktop/widgets/period_bar.dart';

Widget _popup({String? authError, Snapshot? snapshot, int reviewCount = 0}) => MaterialApp(
      home: SizedBox(
        width: 420,
        height: 620,
        child: PopupView(
          snapshot: snapshot ?? Snapshot.empty,
          authError: authError,
          reviewCount: reviewCount,
          periods: Periods.empty,
          selection: PeriodSelection.thisMonth,
          onPeriodChanged: (_) {},
          txns: const [],
          feed: const [],
          connected: false,
          onOpenFull: () {},
          onQuit: () {},
          onSetup: () {},
          onReview: () {},
          onRefresh: () {},
          onToggleLearning: () {},
        ),
      ),
    );

void main() {
  testWidgets('a 401 shows an explanation, not a silent zero', (tester) async {
    await tester.pumpWidget(_popup(authError: 'GET /v1/snapshot -> 401'));
    await tester.pump();

    expect(
      find.textContaining('Cannot read the vault'),
      findsOneWidget,
      reason: 'an auth failure must be stated, not implied by zeros',
    );
    // And it must say the data is safe — that was the user's actual fear.
    expect(find.textContaining('Your data is intact'), findsOneWidget);
  });

  testWidgets('no banner when authentication is fine', (tester) async {
    await tester.pumpWidget(_popup());
    await tester.pump();
    expect(find.textContaining('Cannot read the vault'), findsNothing);
  });

  testWidgets('a genuinely empty vault is NOT reported as an auth error',
      (tester) async {
    // The inverse error: crying "auth failure" at a new, legitimately empty
    // vault would be just as misleading.
    await tester.pumpWidget(_popup(snapshot: Snapshot.empty));
    await tester.pump();
    expect(find.textContaining('rejected'), findsNothing);
  });

  test('VaultAuthException names the status and path', () {
    const e = VaultAuthException(401, '/v1/snapshot');
    expect(e.toString(), contains('401'));
    expect(e.toString(), contains('/v1/snapshot'));
    expect(e.toString(), contains('token'));
  });

  testWidgets('the review badge shows a count, not a literal', (tester) async {
    // The badge read '\$badge' in source, so the escaped dollar printed the
    // literal text "$badge" in the UI instead of interpolating the count.
    await tester.pumpWidget(_popup(reviewCount: 7));
    await tester.pump();
    expect(find.text('7'), findsOneWidget);
    expect(find.textContaining('badge'), findsNothing,
        reason: 'the placeholder name must never reach the screen');
  });

  testWidgets('no badge at all when nothing needs review', (tester) async {
    await tester.pumpWidget(_popup(reviewCount: 0));
    await tester.pump();
    expect(find.textContaining('badge'), findsNothing);
    expect(find.text('0'), findsNothing, reason: 'zero pending shows no badge');
  });
}
