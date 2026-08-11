/** WO09/WO10 backend contract regression coverage. */
import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "./schema.js";
import { createEventBus, createLogger, createPaths } from "./adapters.js";
import { nullAiProvider } from "./ai-provider.js";
import { ingestFile, JobWorker } from "./pipeline.js";
import type { Ports } from "./ports.js";
import { writeClaim, winningClaim, setDocumentParty } from "./claims.js";
import {
  PIPELINE_STATES, transitionPipeline, pipelineEventsFor, sourceActionFor,
  LEARNING_TRIGGERS, generateLearningQuestions, answerLearningQuestion, ignoreLearningQuestion,
  listVocabulary, createRegistryValue, resolveAccountEntity, identifierConflicts,
  FrankfurterFx, detectDocumentType, extractTypedDocument, impactFor,
} from "./workorders.js";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (error) { console.log(`  FAIL  ${name}\n        ${(error as Error).stack ?? error}`); failed++; }
}
const logger = createLogger("error");
const events: unknown[] = [];
const ports: Ports = {
  logger,
  clock: { now: () => new Date("2026-08-10T00:00:00.000Z"), isoNow: () => "2026-08-10T00:00:00.000Z" },
  paths: {} as Ports["paths"], converter: {} as Ports["converter"],
  bus: { ...createEventBus(logger), publish: (e) => { events.push(e); } },
};
const seedDoc = (db: ReturnType<typeof openDatabase>, id: string) => db.prepare(
  "INSERT INTO documents(id,sha256,original_filename,raw_path,received_at) VALUES(?,?,?,?,?)",
).run(id, `sha-${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, ports.clock.isoNow());
const seedEntity = (db: ReturnType<typeof openDatabase>, id: string, kind: string, name: string, identifiers?: object) => db.prepare(
  "INSERT INTO entities(id,kind,display_name,status,identifiers_json,created_at) VALUES(?,?,?,?,?,?)",
).run(id, kind, name, "confirmed", identifiers ? JSON.stringify(identifiers) : null, ports.clock.isoNow());

console.log("\nWO09 + WO10 backend contracts\n");

await check("canonical pipeline persists every ordered transition and terminal policy", () => {
  const db = openDatabase(":memory:");
  assert.deepEqual(PIPELINE_STATES, ["received","stable","hashed","triaged","converting","analysing","complete","failed","duplicate","irrelevant","password_needed"]);
  const statePath = ["received","stable","hashed","triaged","converting","analysing","complete"] as const;
  statePath.forEach((toState, i) => transitionPipeline(db, { documentId:"doc-p", toState, source:"drop", timestamp:`2026-08-10T00:00:0${i}.000Z` }));
  assert.deepEqual(pipelineEventsFor(db,"doc-p").map(e => e.toState), statePath);
  assert.equal(sourceActionFor("complete"), "remove");
  for (const state of ["failed","duplicate","irrelevant","password_needed"] as const) assert.equal(sourceActionFor(state), "archive-copy-retain-source");
  assert.throws(() => transitionPipeline(db,{documentId:"other",toState:"complete",source:"x",timestamp:ports.clock.isoNow()}),/illegal/);
  db.close();
});

await check("production intake keeps a watched source until complete and records the canonical path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "q2v-delayed-source-"));
  try {
    const db = openDatabase(path.join(root, "vault.db"));
    const drop = path.join(root, "Drop");
    await fs.mkdir(drop, { recursive: true });
    const source = path.join(drop, "invoice.txt");
    await fs.writeFile(source, "Invoice\nTotal: INR 100.00\n");
    const productionPorts: Ports = {
      ...ports,
      paths: createPaths(path.join(root, "vault")),
      converter: {
        async toMarkdown(file) {
          return { markdown: await fs.readFile(file, "utf8"), converter: "test", converterVersion: "1" };
        },
      },
    };

    const intake = await ingestFile(db, productionPorts, source, {
      source: "folder",
      consumeSource: true,
      checkStable: false,
    });
    assert.equal(intake.disposition, "accepted");
    assert.equal(await fs.stat(source).then(() => true, () => false), true, "accepted source was removed before analysis completed");

    const worker = new JobWorker(db, productionPorts, nullAiProvider);
    await worker.tick();
    assert.equal(await fs.stat(source).then(() => true, () => false), true, "conversion removed the source before analysis completed");
    await worker.tick();
    assert.equal(await fs.stat(source).then(() => true, () => false), false, "complete pipeline did not remove watched source");
    assert.deepEqual(
      pipelineEventsFor(db, intake.document_id!).map((event) => event.toState),
      ["received", "stable", "hashed", "triaged", "converting", "analysing", "complete"],
    );
    db.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check("claims preserve user confirmation on reanalysis and parties are role/kind safe", () => {
  const db = openDatabase(":memory:"); seedDoc(db,"doc-c");
  seedEntity(db,"person","person","Mahesh"); seedEntity(db,"acct","account","HDFC •5675"); seedEntity(db,"org","organisation","Vendor");
  writeClaim(db,ports,{subject:"document",subjectId:"doc-c",field:"category",value:"consulting",source:"user",provenanceRef:"review:1",editedBy:"u1"});
  assert.throws(() => writeClaim(db,ports,{subject:"document",subjectId:"doc-c",field:"category",value:"other",source:"ai"}), /confirmed user/);
  const claim = winningClaim(db,"document","doc-c","category")!;
  assert.equal(claim.value,"consulting"); assert.equal(claim.provenance_ref,"review:1"); assert.equal(claim.edited_by,"u1");
  setDocumentParty(db,ports,{documentId:"doc-c",entityId:"acct",role:"source_of_funds"});
  assert.equal((db.prepare("SELECT provenance FROM document_parties WHERE document_id='doc-c'").get() as {provenance:string}).provenance,"user-confirmed");
  assert.throws(() => setDocumentParty(db,ports,{documentId:"doc-c",entityId:"org",role:"source_of_funds"}),/kind/);
  assert.ok(db.prepare("SELECT 1 FROM learned_rules WHERE source='passive-correction'").get(),"passive rule candidate missing");
  db.close();
});

await check("adaptive learning exposes seven triggers, dedupes, budgets, backoff, and resolves silently", () => {
  const db = openDatabase(":memory:"); events.length = 0;
  assert.equal(LEARNING_TRIGGERS.length,7);
  const input = { documentId:"doc-l", pipelineState:"analysing" as const, ambiguities:[{kind:"new-entity" as const,dedupeKey:"entity:acme",prompt:"Is ACME new?",sourceFact:{name:"ACME"},predictedRule:{kind:"entity-rule" as const,payload:{match_key:"acme",value:"ent-acme"}},noveltyScore:.9,why:"ACME has not appeared before"}] };
  assert.equal(generateLearningQuestions(db,ports,input).length,1);
  assert.equal(generateLearningQuestions(db,ports,input).length,0,"duplicate was re-asked");
  const qid = (db.prepare("SELECT id FROM training_reviews").get() as {id:number}).id;
  ignoreLearningQuestion(db,ports,qid);
  assert.ok((db.prepare("SELECT backoff_until FROM training_reviews WHERE id=?").get(qid) as {backoff_until:string}).backoff_until);
  const input2 = {...input, ambiguities:[{...input.ambiguities[0],dedupeKey:"entity:beta",prompt:"Is Beta new?"}]};
  const q2 = generateLearningQuestions(db,ports,input2)[0];
  const answered = answerLearningQuestion(db,ports,q2.question_id,"yes");
  assert.ok(answered.ruleId);
  const learned = db.prepare("SELECT kind,match_kind,value FROM learned_rules WHERE id=?").get(answered.ruleId) as {kind:string;match_kind:string|null;value:string};
  assert.deepEqual(learned,{kind:"descriptor_to_entity",match_kind:"organisation",value:"ent-acme"});
  assert.equal(generateLearningQuestions(db,ports,input2).length,0);
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('learning.enabled','false')").run();
  const input3 = {...input, ambiguities:[{...input.ambiguities[0],dedupeKey:"entity:gamma"}]};
  assert.equal(generateLearningQuestions(db,ports,input3).length,0);
  assert.ok(events.some(e => (e as {type?:string}).type === "learning.question"));
  assert.ok(events.some(e => (e as {type?:string}).type === "learning.rule.applied"));
  db.close();
});

await check("entity conflicts remain visible and accounts dedupe by accountRef", () => {
  const db=openDatabase(":memory:");
  seedEntity(db,"p1","person","A",{email:"same@example.com"}); seedEntity(db,"o1","organisation","A Ltd",{email:"same@example.com"});
  seedEntity(db,"p2","person","B",{email:"same@example.com"});
  const conflicts=identifierConflicts(db,"same@example.com");
  assert.equal(conflicts.length,3); assert.ok(conflicts.some(c=>c.crossKind)); assert.ok(conflicts.some(c=>c.sameKind));
  const a=resolveAccountEntity(db,ports,{institution:"HDFC",last4:"5675",type:"bank"});
  const b=resolveAccountEntity(db,ports,{institution:"hdfc",last4:"5675",type:"bank"});
  assert.equal(a.id,b.id); assert.equal(a.created,true); assert.equal(b.created,false);
  db.close();
});

await check("vocabularies and create-new registry provide non-blocking did-you-mean", () => {
  const db=openDatabase(":memory:"); seedEntity(db,"acct","account","HDFC •5675");
  assert.ok(listVocabulary(db,"docTypes").includes("tax_invoice"));
  assert.ok(listVocabulary(db,"impactBuckets").includes("investment_purchase"));
  assert.equal((listVocabulary(db,"accounts") as Array<{id:string}>)[0].id,"acct");
  createRegistryValue(db,ports,"category","Professional Services");
  const next=createRegistryValue(db,ports,"category","Professionl Services");
  assert.equal(next.created,true); assert.equal(next.suggestion,"Professional Services");
  db.close();
});

await check("Frankfurter uses requested/cache/prior business day and stale offline fallback", async () => {
  const db=openDatabase(":memory:"); let calls=0;
  const fx=new FrankfurterFx(db,async(url)=>{ calls++; return url.includes("2026-08-10") ? {ok:false,status:404,json:async()=>({})} : {ok:true,status:200,json:async()=>({rates:{INR:90}})}; });
  const first=await fx.convert({amountMinor:10000,from:"USD",to:"INR",date:"2026-08-10"});
  assert.equal(first?.rateDate,"2026-08-07"); assert.equal(first?.freshness,"prior-business-day"); assert.equal(first?.convertedAmount,900000);
  const jpy=await new FrankfurterFx(db,async()=>({ok:true,status:200,json:async()=>({rates:{JPY:150}})})).convert({amountMinor:10000,from:"USD",to:"JPY",date:"2026-08-11"});
  assert.equal(jpy?.convertedAmount,15000,"USD minor units must be rescaled to zero-decimal JPY");
  const usd=await new FrankfurterFx(db,async()=>({ok:true,status:200,json:async()=>({rates:{USD:0.00667}})})).convert({amountMinor:15000,from:"JPY",to:"USD",date:"2026-08-11"});
  assert.equal(usd?.convertedAmount,10005,"zero-decimal JPY must be rescaled to USD cents");
  const cached=await new FrankfurterFx(db,async()=>{throw new Error("should not call")}).convert({amountMinor:10000,from:"USD",to:"INR",date:"2026-08-07"});
  assert.equal(cached?.freshness,"cache-hit"); assert.ok(calls>=2);
  const stale=await new FrankfurterFx(db,async()=>{throw new Error("offline")}).convert({amountMinor:10000,from:"USD",to:"INR",date:"2026-08-12"});
  assert.equal(stale?.freshness,"stale"); db.close();
});

await check("taxonomy detects and generally extracts invoice and contract-note content", () => {
  const invoice=`TAX INVOICE\nGSTIN: 29ABCDE1234F1Z5\nInvoice Number: INV/2026-27/01\nInvoice Date: April 1, 2026\nDue Date: April 15, 2026\nBill To: PetaSight Inc.\nCurrency: USD\nData Science consulting services | 998393 | 0.3043 | 5397 | 1642.31\nKilo Pass subscription | 998393 | 1 | 49 | 49\nTotal: 1,691.31 USD`;
  assert.deepEqual(detectDocumentType(invoice),{type:"tax_invoice",confidence:1});
  const ix=extractTypedDocument(invoice);
  assert.equal(ix.documentType,"tax_invoice"); assert.equal(ix.documentNumber,"INV/2026-27/01"); assert.equal(ix.amountMinor,169131); assert.equal(ix.lineItems?.length,2);
  const note=`PAYTM MONEY LIMITED\nCONTRACT NOTE CUM TAX INVOICE\nContract Note No: 2216643\nTrade Date: 01/07/2026\nSettlement Number: 2026662\nSettlement Date: 02/07/2026\nREC LIMITED INE020B01018 Qty 10 Price 250.00 Net 2591.40 DR\nKALPATARU PROJECTS INTERNATION INE220B01022 Qty 5 Price 1800.00 Net 9493.40 DR\nNet amount receivable/payable by client: 12,121.96 DR`;
  const nx=extractTypedDocument(note);
  assert.equal(nx.documentType,"contract_note"); assert.equal(nx.contractNoteNumber,"2216643"); assert.equal(nx.amountMinor,1212196); assert.equal(nx.trades?.length,2);
  assert.match(impactFor("contract_note","investment_purchase",472287).wording,/Added .*4,722\.87 to investments/);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
