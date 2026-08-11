import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quick2avault_desktop/features/review/api.dart';
import 'package:quick2avault_desktop/features/review/state.dart';
import 'package:quick2avault_desktop/features/review/widgets.dart';

class _Gateway implements DocumentGateway {
  String? entityId;

  @override
  Future<DetailDocument> detail(String id) => throw UnimplementedError();

  @override
  Future<void> setField(String id, String field, Object value) =>
      throw UnimplementedError();

  @override
  Future<void> setParty(String id, String role, String entityId) async {
    this.entityId = entityId;
  }
}

void main() {
  testWidgets('party choices use entity IDs when display names collide', (
    tester,
  ) async {
    final gateway = _Gateway();
    const choices = [
      PartyChoice(id: 'person-1', displayName: 'Priya Nair'),
      PartyChoice(id: 'person-2', displayName: 'Priya Nair'),
    ];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PartiesSection(
            choices: const {DocumentPartyRole.owner: choices},
            onChanged: (role, entityId) {
              if (entityId != null) {
                gateway.setParty('doc-1', role.apiValue, entityId);
              }
            },
          ),
        ),
      ),
    );

    await tester.tap(find.byType(DropdownButton<String>).first);
    await tester.pumpAndSettle();
    final secondChoice = find
        .byWidgetPredicate(
          (widget) =>
              widget is DropdownMenuItem<String> && widget.value == 'person-2',
        )
        .last;
    await tester.tap(secondChoice, warnIfMissed: false);
    await tester.pumpAndSettle();

    expect(gateway.entityId, 'person-2');
  });
}
