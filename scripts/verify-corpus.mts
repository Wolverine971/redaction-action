/**
 * Verify eval/corpus/truth.json against the generated PDFs.
 *
 *   pnpm exec tsx scripts/verify-corpus.mts
 *
 * 1. Extracts each page with mupdf (preserve-whitespace), collapses whitespace,
 *    and asserts every truth span's (text, occurrence) exists on its page and
 *    lands at the recorded `start` offset.
 * 2. Completeness lint: every occurrence of a sensitive token (cast names,
 *    initials, home-address street names/numbers, SSN digits) must be covered by
 *    some truth span (redact or keep). This catches unlabeled PII, which would
 *    otherwise be scored as a false positive for a correct system.
 * Exits non-zero on any failure.
 */
import * as mupdf from "mupdf";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Span {
  page: number;
  text: string;
  occurrence: number;
  expected: "redact" | "keep";
  category: string;
  entityId?: string;
  ambiguous?: boolean;
  kind?: string;
  start?: number;
  wrapped?: boolean;
}
interface Truth {
  entities: { id: string; type: string; canonical: string; redact: boolean; aliases: string[] }[];
  documents: { file: string; title: string; pages: number; spans: Span[] }[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "eval", "corpus");
const truth = JSON.parse(await readFile(path.join(CORPUS, "truth.json"), "utf8")) as Truth;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Start index of the n-th (0-based) occurrence; overlapping, case-sensitive. */
function nthIndex(hay: string, needle: string, n: number): number {
  let i = hay.indexOf(needle);
  for (let k = 0; k < n && i !== -1; k++) i = hay.indexOf(needle, i + 1);
  return i;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- Sensitive tokens for the completeness lint -------------------------------
const HONORIFIC = new Set(["Mr.", "Mrs.", "Ms.", "Miss", "Dr."]);
const ADDRESS_STOP = new Set(
  "street st avenue ave court ct lane ln road rd apt apartment suite baltimore maryland md towson dundalk n s e w the house block"
    .split(" "),
);
const tokenSources = new Map<string, string>(); // regex source -> entity id
for (const e of truth.entities.filter((x) => x.redact)) {
  if (e.type === "ssn") {
    const d = e.canonical.replace(/\D/g, "");
    tokenSources.set(`(?<![0-9])${d.slice(5)}(?![0-9])`, e.id);
    tokenSources.set(`${d.slice(0, 3)}[\\s-]?${d.slice(3, 5)}[\\s-]?${d.slice(5)}`, e.id);
    continue;
  }
  for (const alias of e.aliases) {
    for (let tok of alias.split(" ")) {
      tok = tok.replace(/'s$/, "").replace(/[,;:]$/, "");
      if (!/^([A-Z]\.){2,}$/.test(tok)) tok = tok.replace(/\.$/, "");
      if (!tok || HONORIFIC.has(tok) || HONORIFIC.has(tok + ".")) continue;
      if (e.type === "person") {
        if (/^[A-Z]$/.test(tok) || !/^[A-Z]/.test(tok)) continue;
      } else {
        if (ADDRESS_STOP.has(tok.toLowerCase())) continue;
        if (/^\d+$/.test(tok) && (tok.length < 3 || tok.length > 4)) continue;
        if (!/^[A-Z0-9]/.test(tok)) continue;
      }
      tokenSources.set(`(?<![A-Za-z0-9])${escapeRe(tok)}(?![A-Za-z0-9])`, e.id);
    }
  }
}
const lintRes = [...tokenSources.keys()].map((src) => new RegExp(src, "g"));

// ---- Run ------------------------------------------------------------------------
const failures: string[] = [];
const lintFailures: string[] = [];
const byCat = new Map<string, number>();
let pagesTotal = 0;
let spansTotal = 0;
let ambiguous = 0;
let wrapped = 0;

for (const d of truth.documents) {
  const bytes = await readFile(path.join(CORPUS, "pdfs", d.file));
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const n = doc.countPages();
  pagesTotal += n;
  if (n !== d.pages) failures.push(`${d.file}: truth says ${d.pages} pages, PDF has ${n}`);
  const pageTexts: string[] = [];
  for (let i = 0; i < n; i++) {
    pageTexts.push(normalize(doc.loadPage(i).toStructuredText("preserve-whitespace").asText()));
  }

  const covered: [number, number][][] = pageTexts.map(() => []);
  for (const s of d.spans) {
    spansTotal++;
    if (s.ambiguous) ambiguous++;
    if (s.wrapped) wrapped++;
    const key = `${s.expected}/${s.category}`;
    byCat.set(key, (byCat.get(key) ?? 0) + 1);
    if (s.expected === "redact" && !s.entityId) failures.push(`${d.file} p${s.page}: redact span "${s.text}" has no entityId`);
    if (s.text !== normalize(s.text)) failures.push(`${d.file} p${s.page}: span text not normalized: "${s.text}"`);
    const pt = pageTexts[s.page - 1];
    if (pt === undefined) {
      failures.push(`${d.file}: span "${s.text}" on missing page ${s.page}`);
      continue;
    }
    const at = nthIndex(pt, s.text, s.occurrence);
    if (at === -1) {
      failures.push(`${d.file} p${s.page}: "${s.text}" occurrence ${s.occurrence} not found`);
      continue;
    }
    if (s.start !== undefined && s.start !== at) {
      failures.push(`${d.file} p${s.page}: "${s.text}"#${s.occurrence} found at ${at}, truth start ${s.start}`);
    }
    covered[s.page - 1].push([at, at + s.text.length]);
  }

  // Overlapping truth spans would make scoring ambiguous.
  covered.forEach((iv, pi) => {
    const sorted = [...iv].sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k][0] < sorted[k - 1][1]) failures.push(`${d.file} p${pi + 1}: overlapping truth spans at ${sorted[k][0]}`);
    }
  });

  // Completeness lint.
  pageTexts.forEach((pt, pi) => {
    for (const re of lintRes) {
      re.lastIndex = 0;
      for (const m of pt.matchAll(re)) {
        const a = m.index ?? 0;
        const b = a + m[0].length;
        if (!covered[pi].some(([s, e]) => s <= a && b <= e)) {
          lintFailures.push(`${d.file} p${pi + 1}: unlabeled "${m[0]}" in "...${pt.slice(Math.max(0, a - 40), b + 40)}..."`);
        }
      }
    }
  });
}

console.log(`docs: ${truth.documents.length}  pages: ${pagesTotal}  spans: ${spansTotal}`);
console.log(`ambiguous person spans: ${ambiguous}  wrapped spans: ${wrapped}`);
console.log("spans by expected/category:");
for (const [k, v] of [...byCat.entries()].sort()) console.log(`  ${k.padEnd(28)} ${v}`);
const redactTotal = [...byCat.entries()].filter(([k]) => k.startsWith("redact/")).reduce((a, [, v]) => a + v, 0);
console.log(`  ${"TOTAL redact".padEnd(28)} ${redactTotal}`);
console.log(`  ${"TOTAL keep".padEnd(28)} ${spansTotal - redactTotal}`);
console.log(`completeness lint: ${lintRes.length} sensitive-token patterns checked`);

if (failures.length || lintFailures.length) {
  console.error(`\nFAILED: ${failures.length} span check failure(s), ${lintFailures.length} unlabeled sensitive token(s)`);
  for (const f of [...failures, ...lintFailures].slice(0, 200)) console.error("  " + f);
  process.exit(1);
}
console.log("\nOK: every span found at its recorded occurrence/offset; no unlabeled sensitive tokens.");
