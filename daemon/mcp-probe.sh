#!/usr/bin/env bash
# End-to-end probe: drives daemon/mcp-server.ts over real stdio JSON-RPC
# against a live daemon. Exercises every tool plus the cross-kind merge guard.
#
#   Q2AV_URL=http://127.0.0.1:4479 Q2AV_TOKEN=devtoken ./daemon/mcp-probe.sh
set -uo pipefail
cd "$(dirname "$0")/.."

URL="${Q2AV_URL:-http://127.0.0.1:4477}"
TOKEN="${Q2AV_TOKEN:-}"

# Pull real ids from the daemon so the probe uses live data, not fixtures.
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/transactions?limit=50" -o /tmp/q2v-probe-txn.json
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/documents?limit=50"    -o /tmp/q2v-probe-doc.json
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/entities"              -o /tmp/q2v-probe-ent.json

IDS=$(node --input-type=module -e '
import fs from "node:fs";
const t = JSON.parse(fs.readFileSync("/tmp/q2v-probe-txn.json","utf8")).transactions;
const d = JSON.parse(fs.readFileSync("/tmp/q2v-probe-doc.json","utf8")).documents;
const e = JSON.parse(fs.readFileSync("/tmp/q2v-probe-ent.json","utf8")).entities;
const multi = t.find(x => (x.evidence?.length ?? 0) > 1) ?? t[0];
const doc   = d.find(x => /^B-/.test(x.original_filename)) ?? d[0];
// Two entities of DIFFERENT kinds — merging these must be refused.
const org   = e.find(x => x.kind === "organisation");
const acct  = e.find(x => x.kind === "account");
console.log([multi?.id ?? "", doc?.id ?? "", org?.id ?? "", acct?.id ?? ""].join(" "));
')
read -r TXN DOC ORG ACCT <<< "$IDS"
echo "live ids: txn=$TXN doc=$DOC org=$ORG acct=$ACCT"
echo

{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_snapshot","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_transactions","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_entities","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"find_gaps","arguments":{}}}'
  echo "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"get_evidence_card\",\"arguments\":{\"transaction_id\":\"$TXN\"}}}"
  echo "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"explain_document\",\"arguments\":{\"document_id\":\"$DOC\"}}}"
  echo '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_review_queue","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"query_documents","arguments":{}}}'
  echo "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"merge_entities\",\"arguments\":{\"from_id\":\"$ORG\",\"into_id\":\"$ACCT\"}}}"
} | npx tsx daemon/mcp-server.ts 2>/tmp/q2v-mcp-err.log > /tmp/q2v-mcp-out.jsonl

node --input-type=module -e '
import fs from "node:fs";
const lines = fs.readFileSync("/tmp/q2v-mcp-out.jsonl","utf8").split("\n").filter(Boolean);
const LABEL = {3:"get_snapshot",4:"list_transactions",5:"list_entities",6:"find_gaps",
               7:"get_evidence_card",8:"explain_document",9:"get_review_queue",
               10:"query_documents",11:"merge_entities (cross-kind, MUST refuse)"};
let tools = 0;
for (const l of lines) {
  let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id === 1) console.log("INITIALIZE ->", m.result?.serverInfo?.name, m.result?.serverInfo?.version, "\n");
  else if (m.id === 2) {
    tools = (m.result?.tools ?? []).length;
    console.log(`TOOLS/LIST -> ${tools} tools: ` + (m.result?.tools ?? []).map(t=>t.name).join(", ") + "\n");
  } else if (m.id >= 3) {
    const txt = m.result?.content?.[0]?.text ?? JSON.stringify(m.error);
    console.log("──────── " + (LABEL[m.id] ?? m.id) + " ────────");
    console.log(txt.split("\n").slice(0, 14).join("\n"));
    console.log();
  }
}
console.log(`tools registered: ${tools}`);
'
echo "--- stderr ---"; head -2 /tmp/q2v-mcp-err.log
