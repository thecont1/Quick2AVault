/// Currency-aware money formatting utilities.
///
/// Extracted from api.dart so both the Freezed models (Txn.sourceAmount) and
/// the widget layer can share a single implementation without circular
/// imports.
library;

/// Minor units per major unit by currency. Anything unlisted uses 100 — the
/// common case (USD, EUR, GBP, INR, ...). Zero-decimal currencies would
/// render a nonsense ".00" otherwise.
const _zeroDecimalCurrencies = {'JPY', 'KRW', 'VND', 'IDR', 'HUF'};

/// Currency-aware money formatting (work order 05 §A.2).
///
/// The currency is a REQUIRED argument — call sites that drop it fail to
/// compile, which is acceptance test §A.4.7 by construction: the formatter
/// cannot silently fall back to INR.
///
///   money(59785, 'USD')  -> "USD 597.85"
///   money(64372, 'INR')  -> "₹643.72"   (lakh/crore grouping)
///   money(59785, null)   -> "597.85 (currency uncertain)"
String money(int minor, String? currency) {
  final code = currency?.trim().toUpperCase();
  if (code == null || code.isEmpty) {
    final neg = minor < 0;
    final whole = (minor.abs() ~/ 100).toString();
    final frac = (minor.abs() % 100).toString().padLeft(2, '0');
    return '${neg ? '-' : ''}$whole.$frac (currency uncertain)';
  }
  if (code == 'INR') return rupees(minor);

  final unit = _zeroDecimalCurrencies.contains(code) ? 1 : 100;
  final neg = minor < 0;
  final whole = (minor.abs() ~/ unit).toString();
  // Thousands grouping — the lakh/crore scheme is INR-specific.
  final grouped = whole.replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (m) => ',',
  );
  final body = unit == 1
      ? grouped
      : '$grouped.${(minor.abs() % unit).toString().padLeft(2, '0')}';
  // Always the ISO code for non-home currencies: "$" is ambiguous across
  // USD/SGD/AUD, and the amount must never be readable as rupees.
  return '${neg ? '-' : ''}$code $body';
}

/// Source amount with its optional converted home value as a separate,
/// labelled figure (work order 05 §A.2): "USD 597.85  ≈ INR 50,208.00".
String sourceWithHome(
  int amountMinor,
  String? currency,
  int? homeAmountMinor, {
  String homeCurrency = 'INR',
}) {
  final source = money(amountMinor, currency);
  if (homeAmountMinor == null) return source;
  return '$source  ≈ ${money(homeAmountMinor, homeCurrency)}';
}

/// ₹1,23,456.78 — Indian lakh/crore grouping, not thousands.
/// A naive NumberFormat gives ₹123,456.78, which is wrong for the jurisdiction.
String rupees(int minor) {
  final neg = minor < 0;
  final s = (minor.abs() ~/ 100).toString();
  final paise = (minor.abs() % 100).toString().padLeft(2, '0');

  String grouped;
  if (s.length <= 3) {
    grouped = s;
  } else {
    final last3 = s.substring(s.length - 3);
    var rest = s.substring(0, s.length - 3);
    final parts = <String>[];
    while (rest.length > 2) {
      parts.insert(0, rest.substring(rest.length - 2));
      rest = rest.substring(0, rest.length - 2);
    }
    if (rest.isNotEmpty) parts.insert(0, rest);
    grouped = '${parts.join(',')},$last3';
  }
  return '${neg ? '-' : ''}₹$grouped.$paise';
}

/// ₹1,23,456 — whole rupees, no paise. The reference design shows figures at
/// a glance; two decimal places are noise at that size.
String rupeesWhole(int minor) {
  final full = rupees(minor);
  final dot = full.lastIndexOf('.');
  return dot > 0 ? full.substring(0, dot) : full;
}
