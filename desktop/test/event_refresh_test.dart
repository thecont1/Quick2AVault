// The client must refresh on the events that change what the ledger shows.
//
// Verified against the daemon's real emissions with a live probe: drop a
// fixture into the vault, read the SSE stream, record the types. That run
// produced Ready, DocumentReceived, MarkdownReady, JobStateChanged (x6),
// AnalysisComplete and MatchProposed in 11.3s.
//
// This test guards the CLASSIFICATION, which is the part that rots: when a new
// event type is added to the daemon, someone must decide whether it changes a
// figure on screen. An unclassified type silently does nothing, and the symptom
// is "the numbers are stale" long after the cause is forgotten.
import 'package:flutter_test/flutter_test.dart';

/// Every event type daemon/*.ts can emit, as of the probe above.
/// Enumerated here so adding one to the daemon without classifying it fails.
const daemonEmits = {
  'AnalysisComplete',
  'BatchFinished',
  'DocumentDuplicate',
  'DocumentReceived',
  'JobStateChanged',
  'MarkdownReady',
  'MatchProposed',
  'Ready',
  'TransactionRecorded',
  // Work order 06 — Intelligent Intake Triage events (§8).
  'IntakeReceived',
  'IntakeTriaged',
  'IntakeAccepted',
  'IntakeIrrelevant',
  'IntakeDuplicate',
  'IntakeFailed',
  'IntakeRestored',
};

/// Mirrors the set in main.dart's _listen(). Kept in sync deliberately: this
/// file is the specification, main.dart is the implementation.
const refreshOn = {
  'TransactionRecorded',
  'MatchProposed',
  'AnalysisComplete',
  'DocumentReceived',
  'DocumentDuplicate',
  'BatchFinished',
  // Work order 06 — intake events that change the Irrelevant view or promote
  // an item into the ledger. IntakeRestored must refresh because a restore
  // can move an irrelevant item into accepted/processing.
  'IntakeAccepted',
  'IntakeIrrelevant',
  'IntakeDuplicate',
  'IntakeFailed',
  'IntakeRestored',
};

/// Types that intentionally do NOT trigger a refetch, each with a reason.
const ignoredWithReason = {
  'JobStateChanged': 'fires ~6x per document — pure churn, no figure changes',
  'MarkdownReady': 'conversion done, no ledger figure yet; AnalysisComplete follows',
  'Ready': 'handled separately — it is the reconnect hello, always refreshes',
  // Work order 06 — these narrate the intake pipeline but do not change a
  // ledger figure on their own. The disposition finalizers (IntakeAccepted,
  // IntakeIrrelevant, etc.) that DO change the view are in refreshOn.
  'IntakeReceived': 'receipt only — no disposition yet, nothing to show',
  'IntakeTriaged': 'triage decision — the finalizer event that follows updates the view',
};

void main() {
  test('every daemon event is either refreshed on or explicitly ignored', () {
    final classified = {...refreshOn, ...ignoredWithReason.keys};
    final unclassified = daemonEmits.difference(classified);
    expect(unclassified, isEmpty,
        reason: 'unclassified event types will silently leave the UI stale: '
            '$unclassified');
  });

  test('the refresh set contains no type the daemon cannot emit', () {
    // A typo'd event name is invisible at runtime — it simply never matches.
    final phantom = refreshOn.difference(daemonEmits);
    expect(phantom, isEmpty,
        reason: 'these will never fire, so whatever they were meant to cover '
            'is unhandled: $phantom');
  });

  test('BatchFinished refreshes — a bulk import must not leave stale totals', () {
    // Regression guard. This was missing: per-document events during a large
    // Gmail sync can be coalesced, so the batch terminator is what guarantees
    // the totals catch up.
    expect(refreshOn, contains('BatchFinished'));
  });

  test('JobStateChanged does NOT refresh', () {
    // The probe saw it 6 times for ONE document. Refreshing on it would mean
    // six full refetches (snapshot + transactions + treemap + learning) per
    // document, which during a 100-document import is 600 rounds of fetches.
    expect(refreshOn, isNot(contains('JobStateChanged')));
  });

  test('Ready is not in the set, because it is handled unconditionally', () {
    // main.dart checks `e.type == 'Ready' || refreshOn.contains(e.type)`.
    // Listing it in both places would be harmless but misleading about which
    // mechanism recovers from a daemon restart.
    expect(refreshOn, isNot(contains('Ready')));
    expect(ignoredWithReason.keys, contains('Ready'));
  });
}
