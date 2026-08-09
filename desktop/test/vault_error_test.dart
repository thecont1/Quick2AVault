// Work order 07 §C3 — VaultError maps raw exceptions to user-facing errors.
//
// Never show raw exception strings. Map errors to a title, explanation,
// recovery action, and optional technical disclosure.
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/api.dart';

void main() {
  group('VaultError.from', () {
    test('VaultAuthException maps to an auth error with recovery', () {
      final e = VaultAuthException(401, '/v1/snapshot');
      final err = VaultError.from(e);
      expect(err.title, 'Authentication failed');
      expect(err.explanation, contains('401'));
      expect(err.recovery, contains('token'));
      expect(err.technical, e.toString());
    });

    test('PersonConflict maps to a name-collision error', () {
      final e = PersonConflict('Already exists', existingId: 'ent_x');
      final err = VaultError.from(e);
      expect(err.title, 'Name already in use');
      expect(err.recovery, contains('Merge'));
    });

    test('PersonInUse maps to a documents-referenced error', () {
      final e = PersonInUse('Named on 3 documents', documents: 3);
      final err = VaultError.from(e);
      expect(err.title, 'Person is named on documents');
      expect(err.explanation, contains('3'));
    });

    test('NotAStatement maps to a doc-type error', () {
      final e = NotAStatement('not_a_statement');
      final err = VaultError.from(e);
      expect(err.title, 'Not a statement');
    });

    test('ClaimRefusedException maps to a claim error', () {
      final e = const ClaimRefusedException('invalid_value', 'bad value');
      final err = VaultError.from(e);
      expect(err.title, 'Claim refused');
    });

    test('a SocketException-like string maps to daemon unreachable', () {
      final err = VaultError.from(
        Exception('SocketException: connection refused'),
      );
      expect(err.title, 'Daemon unreachable');
      expect(err.recovery, contains('daemon'));
    });

    test('a TimeoutException-like string maps to request timed out', () {
      final err = VaultError.from(
        Exception('TimeoutException after 0:00:10'),
      );
      expect(err.title, 'Request timed out');
    });

    test('a generic exception maps to a safe fallback, not the raw string', () {
      final raw = 'some internal stack trace detail';
      final err = VaultError.from(Exception(raw));
      expect(err.title, 'Something went wrong');
      // The raw string must NOT appear in the user-facing message.
      expect(err.message, isNot(contains(raw)));
      // But it IS available in technical for debugging.
      expect(err.technical, contains(raw));
    });

    test('message is a single line suitable for a snackbar', () {
      final err = VaultError.from(VaultAuthException(403, '/v1/people'));
      expect(err.message, isNot(contains('\n')));
    });
  });
}
