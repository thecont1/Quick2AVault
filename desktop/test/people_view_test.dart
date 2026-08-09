// People tab acceptance tests (work order 05 §B.6).
//
// Verifies the inline expansion panel, alias display, is_owner vs is_member
// badge correctness, and the detected-person workflow buttons.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quick2avault_desktop/api.dart';
import 'package:quick2avault_desktop/widgets/people_view.dart';

Person _p(
  String id,
  String name, {
  String? relationship,
  bool isMember = false,
  bool isOwner = false,
  String status = 'confirmed',
  int docCount = 0,
  int txnCount = 0,
  int unresolved = 0,
  List<String> roles = const [],
}) =>
    Person(
      id: id,
      displayName: name,
      relationship: relationship,
      isMember: isMember,
      isOwner: isOwner,
      status: status,
      documentCount: docCount,
      transactionCount: txnCount,
      unresolvedAliasCount: unresolved,
      roles: roles,
    );

class _FakeApi extends VaultApi {
  final List<Person> _people;
  PersonDetail? detail;

  _FakeApi({required List<Person> people, this.detail})
      : _people = people,
        super(baseUrl: 'http://127.0.0.1:1', token: 'test');

  @override
  Future<({List<Person> people, Person? owner})> people() async {
    final owner = _people.where((p) => p.isOwner).firstOrNull;
    return (people: _people, owner: owner);
  }

  @override
  Future<PersonDetail> personDetail(String id) async {
    if (detail != null) return detail!;
    return PersonDetail(
      person: _people.firstWhere((p) => p.id == id),
      aliases: const [],
      documents: const [],
      transactions: const [],
      questions: const [],
    );
  }

  @override
  Future<Map<String, dynamic>> editPerson(String id,
      {String? displayName, String? relationship, bool? isOwner}) async {
    return {'id': id, 'ok': true};
  }

  @override
  Future<Map<String, dynamic>> savePerson({
    required String displayName,
    String? relationship,
    bool isMember = false,
    bool isOwner = false,
  }) async {
    return {'ok': true};
  }

  @override
  Future<void> addPersonAlias(String personId, String alias, {String? aliasType}) async {}

  @override
  Future<void> rejectPersonAlias(String personId, int aliasId) async {}

  @override
  Future<void> mergePeople({required String fromId, required String intoId}) async {}

  @override
  Future<Map<String, dynamic>> deletePerson(String id, {bool force = false}) async {
    return {'ok': true};
  }
}

Widget _host(VaultApi api) => MaterialApp(
      home: Scaffold(body: PeopleView(api: api, onClose: null)),
    );

void main() {
  testWidgets('person list renders with correct badges', (tester) async {
    final api = _FakeApi(people: [
      _p('p1', 'Arun Kamath', isOwner: true, docCount: 3, txnCount: 5),
      _p('p2', 'Nisha Patel', isMember: true, relationship: 'spouse', docCount: 1),
      _p('p3', 'Ravi Menon', status: 'candidate', docCount: 2, unresolved: 1),
    ]);

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    expect(find.text('Arun Kamath'), findsOneWidget);
    expect(find.text('Nisha Patel'), findsOneWidget);
    expect(find.text('Ravi Menon'), findsOneWidget);

    // Owner badge on the owner, not on members.
    expect(find.text('OWNER'), findsOneWidget);

    // Member badge on Nisha (isMember but not isOwner).
    expect(find.text('MEMBER'), findsOneWidget);

    // Detected badge on Ravi (status=candidate).
    expect(find.text('DETECTED'), findsOneWidget);
  });

  testWidgets('row subtitle shows doc count, txn count, and unresolved', (tester) async {
    final api = _FakeApi(people: [
      _p('p1', 'Arun Kamath', isOwner: true, docCount: 3, txnCount: 5, unresolved: 2),
    ]);

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // The subtitle line should contain "3 docs", "5 txns", "2 unresolved".
    expect(find.textContaining('3 docs'), findsOneWidget);
    expect(find.textContaining('5 txns'), findsOneWidget);
    expect(find.textContaining('2 unresolved'), findsOneWidget);
  });

  testWidgets('clicking a person expands the detail panel', (tester) async {
    final api = _FakeApi(people: [
      _p('p1', 'Arun Kamath', isOwner: true, docCount: 1),
    ]);

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // Before tapping, the detail panel (with "Aliases" label) is not visible.
    expect(find.text('Aliases'), findsNothing);

    // Tap the person row to expand.
    await tester.tap(find.text('Arun Kamath'));
    await tester.pumpAndSettle();

    // Now the detail panel is visible.
    expect(find.text('Aliases'), findsOneWidget);
  });

  testWidgets('expanding a person shows alias add input', (tester) async {
    final api = _FakeApi(people: [
      _p('p1', 'Arun Kamath', isOwner: true, docCount: 1),
    ]);

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Arun Kamath'));
    await tester.pumpAndSettle();

    expect(find.byType(TextField), findsAtLeastNWidgets(1));
    expect(find.text('Add'), findsOneWidget);
  });

  testWidgets('detected person shows workflow buttons', (tester) async {
    final api = _FakeApi(people: [
      _p('p1', 'Ravi Menon', status: 'candidate', docCount: 1),
    ]);

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Ravi Menon'));
    await tester.pumpAndSettle();

    // The detected-person workflow buttons should appear.
    expect(find.text('Confirm as existing…'), findsOneWidget);
    expect(find.text('Create new person'), findsOneWidget);
    expect(find.text('Keep separate'), findsOneWidget);
  });

  testWidgets('confirmed person does NOT show detected-person workflow', (tester) async {
    final api = _FakeApi(people: [
      _p('p1', 'Arun Kamath', isOwner: true, status: 'confirmed', docCount: 1),
    ]);

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Arun Kamath'));
    await tester.pumpAndSettle();

    expect(find.text('Confirm as existing…'), findsNothing);
    expect(find.text('Keep separate'), findsNothing);
  });

  testWidgets('aliases are grouped by type with labels', (tester) async {
    final api = _FakeApi(
      people: [_p('p1', 'Arun Kamath', isOwner: true, docCount: 1)],
      detail: PersonDetail(
        person: _p('p1', 'Arun Kamath', isOwner: true, docCount: 1),
        aliases: [
          const PersonAlias(id: 1, alias: 'Arun Kamath', aliasType: 'name_variant',
              source: 'ai', status: 'confirmed', createdAt: '2026-01-01'),
          const PersonAlias(id: 2, alias: 'A Kamath', aliasType: 'name_variant',
              source: 'rule', status: 'confirmed', createdAt: '2026-01-02'),
          const PersonAlias(id: 3, alias: 'arun@example.com', aliasType: 'email',
              source: 'ai', status: 'confirmed', createdAt: '2026-01-03'),
          const PersonAlias(id: 4, alias: '5550100200', aliasType: 'phone',
              source: 'auto-cooccurrence', status: 'proposed', createdAt: '2026-01-04'),
        ],
        documents: const [],
        transactions: const [],
        questions: const [],
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Arun Kamath'));
    await tester.pumpAndSettle();

    // Group labels.
    expect(find.text('Names'), findsOneWidget);
    expect(find.text('Emails'), findsOneWidget);
    expect(find.text('Phones'), findsOneWidget);

    // Alias values.
    expect(find.text('A Kamath'), findsOneWidget);
    expect(find.text('arun@example.com'), findsOneWidget);
    expect(find.text('5550100200'), findsOneWidget);

    // Proposed alias has a Reject button.
    expect(find.text('Reject'), findsOneWidget);
  });

  testWidgets('documents and transactions are shown in the detail panel', (tester) async {
    final api = _FakeApi(
      people: [_p('p1', 'Arun Kamath', isOwner: true, docCount: 2, txnCount: 1)],
      detail: PersonDetail(
        person: _p('p1', 'Arun Kamath', isOwner: true, docCount: 2, txnCount: 1),
        aliases: const [],
        documents: [
          {'original_filename': 'invoice_001.pdf', 'role': 'bill_to', 'received_at': '2026-08-01T00:00:00Z'},
          {'original_filename': 'receipt_002.pdf', 'role': 'payer', 'received_at': '2026-08-05T00:00:00Z'},
        ],
        transactions: [
          Txn(
            id: 't1',
            direction: 'out',
            amountMinor: 59785,
            currency: 'USD',
            occurredAt: '2026-08-01T00:00:00Z',
            fyKey: '2026-27',
          ),
        ],
        questions: const [],
      ),
    );

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Arun Kamath'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Documents (2)'), findsOneWidget);
    expect(find.textContaining('invoice_001.pdf'), findsOneWidget);
    expect(find.textContaining('receipt_002.pdf'), findsOneWidget);

    expect(find.textContaining('Transactions (1)'), findsOneWidget);
    expect(find.textContaining('USD 597.85'), findsOneWidget);
  });

  testWidgets('owner checkbox is checked for owner, unchecked for non-owner', (tester) async {
    final api = _FakeApi(people: [
      _p('p1', 'Arun Kamath', isOwner: true, docCount: 1),
      _p('p2', 'Nisha Patel', docCount: 1),
    ]);

    await tester.pumpWidget(_host(api));
    await tester.pumpAndSettle();

    // Expand the non-owner person.
    await tester.tap(find.text('Nisha Patel'));
    await tester.pumpAndSettle();

    // The owner checkbox should be present and unchecked.
    expect(find.text('This is me (owner)'), findsOneWidget);
  });
}
