/// QAV-FLT-05: Evidence card provider — the linked evidence for the
/// currently selected transaction.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api.dart';
import '../../core/providers.dart';

/// The selected transaction id, or null when no row is open.
final StateProvider<String?> selectedTransactionIdProvider =
    StateProvider<String?>((ref) => null);

/// Notifier for the evidence card of the selected transaction.
class EvidenceCardNotifier
    extends FamilyAsyncNotifier<EvidenceCard, String> {
  @override
  Future<EvidenceCard> build(String txnId) async {
    final api = ref.watch(vaultApiProvider);
    return api.evidenceCard(txnId);
  }
}

/// The evidence card for a given transaction id.
final AsyncNotifierProviderFamily<EvidenceCardNotifier,
    EvidenceCard, String> evidenceCardProvider =
    AsyncNotifierProviderFamily<
        EvidenceCardNotifier, EvidenceCard, String>(
  EvidenceCardNotifier.new,
);
