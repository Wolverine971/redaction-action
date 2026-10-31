/**
 * Synthetic evaluation corpus for the PDF redaction tool.
 *
 *   pnpm exec tsx scripts/generate-corpus.mts
 *
 * Writes eval/corpus/pdfs/NN-name.pdf and eval/corpus/truth.json.
 * Documents are authored below as data with inline markup:
 *
 *   {{key|text}}        span of `text`; `key` is an entity key (john, addr_smith,
 *                       ssn_john, judge, acme, ...) or a keep-decoy key
 *                       (cite, month, modal, word, num)
 *   {{key:kind|text}}   same, with a decoy sub-kind (e.g. {{num:routing|052000113}})
 *
 * The generator strips the markup, lays text out (greedy word wrap, never
 * hyphenates, page breaks), draws every page strictly top-to-bottom, and
 * records each span's page + occurrence index (see README for the exact rule).
 * Output is deterministic: no randomness, fixed PDF dates.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "eval", "corpus");
const PDF_DIR = path.join(OUT_DIR, "pdfs");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Expected = "redact" | "keep";
type Category =
  | "person"
  | "address"
  | "ssn"
  | "ssn_partial"
  | "citation"
  | "official"
  | "org"
  | "decoy_number"
  | "decoy_word";
type EntityType = "person" | "address" | "ssn" | "org";

interface Entity {
  /** Short markup key, e.g. "john". */
  key: string;
  /** Stable id written to truth.json, e.g. "john_smith". */
  id: string;
  type: EntityType;
  canonical: string;
  redact: boolean;
  note: string;
  /** People only: used to decide whether a surname mention is ambiguous. */
  surname?: string;
  gender?: "m" | "f";
  minor?: boolean;
  /** Keep-side person role (judge, attorney, police, court staff). */
  official?: "judge" | "attorney" | "police" | "court_staff";
}

interface TruthSpan {
  page: number;
  text: string;
  occurrence: number;
  expected: Expected;
  category: Category;
  entityId?: string;
  ambiguous?: boolean;
  kind?: string;
  /** Char offset of the span in the whitespace-collapsed page text. */
  start: number;
  /** True when the span is split across two drawn lines. */
  wrapped?: boolean;
  /** Set when the span is in a running header/footer (absent = body). */
  region?: "header" | "footer";
}

interface Run {
  text: string;
  spans: { s: number; e: number; key: string; kind?: string }[];
}

type FontName = "r" | "b" | "i";
type Align = "left" | "center" | "right";

interface ParaBlock {
  k: "p";
  text: string;
  size?: number;
  font?: FontName;
  align?: Align;
  /** First-line indent (pt). Negative = hanging indent for wrapped lines. */
  indent?: number;
  /** Extra left inset (pt) relative to the body margin. */
  left?: number;
  /** Extra right inset (pt). */
  right?: number;
  before?: number;
  /** Keep this paragraph on the same page as the next line. */
  keep?: boolean;
  /** Records the page this paragraph lands on; "@@NAME@@" anywhere in the doc is replaced by it. */
  marker?: string;
}
interface KvBlock {
  k: "kv";
  rows: [string, string][];
  labelW?: number;
  size?: number;
  before?: number;
  left?: number;
}
interface TableBlock {
  k: "table";
  /** Column x offsets (pt from body margin) and alignment. */
  cols: { x: number; align?: "left" | "right" }[];
  head?: string[];
  rows: string[][];
  size?: number;
  before?: number;
}
interface CaptionBlock {
  k: "caption";
  rows: [string, string][];
  size?: number;
  before?: number;
}
interface GapBlock {
  k: "gap";
  h?: number;
}
interface RuleBlock {
  k: "rule";
  before?: number;
}
interface BreakBlock {
  k: "break";
}
type Block = ParaBlock | KvBlock | TableBlock | CaptionBlock | GapBlock | RuleBlock | BreakBlock;

interface HeaderLine {
  left?: string;
  center?: string;
  right?: string;
}

interface DocSpec {
  file: string;
  title: string;
  /** Base font size and line-height factor for body paragraphs. */
  size: number;
  leading: number;
  /** Deposition style: 25 numbered lines per page, spans never wrap. */
  numbered?: boolean;
  header?: (page: number, total: number) => HeaderLine[];
  footer?: (page: number, total: number) => HeaderLine[];
  blocks: Block[];
}

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

const DOCS: DocSpec[] = [];

const p = (text: string, o: Omit<ParaBlock, "k" | "text"> = {}): ParaBlock => ({ k: "p", text, ...o });
/** Centered bold heading that stays with the following line. */
const h = (text: string, o: Omit<ParaBlock, "k" | "text"> = {}): ParaBlock => ({
  k: "p",
  text,
  font: "b",
  align: "center",
  keep: true,
  before: 10,
  ...o,
});
/** Left bold sub-heading. */
const sh = (text: string, o: Omit<ParaBlock, "k" | "text"> = {}): ParaBlock => ({
  k: "p",
  text,
  font: "b",
  keep: true,
  before: 10,
  ...o,
});
const gap = (hh?: number): GapBlock => ({ k: "gap", h: hh });
const rule = (before?: number): RuleBlock => ({ k: "rule", before });
const pageBreak = (): BreakBlock => ({ k: "break" });
const kv = (rows: [string, string][], o: Omit<KvBlock, "k" | "rows"> = {}): KvBlock => ({ k: "kv", rows, ...o });
const caption = (rows: [string, string][], o: Omit<CaptionBlock, "k" | "rows"> = {}): CaptionBlock => ({
  k: "caption",
  rows,
  ...o,
});
const table = (o: Omit<TableBlock, "k">): TableBlock => ({ k: "table", ...o });

// Deposition helpers (numbered mode).
const Q = (text: string): ParaBlock => p(`Q. ${text}`, { indent: 36 });
const A = (text: string): ParaBlock => p(`A. ${text}`, { indent: 36 });
const SAY = (speaker: string, text: string): ParaBlock => p(`${speaker}: ${text}`, { indent: 36 });
const NOTE = (text: string): ParaBlock => p(`(${text})`, { indent: 72 });

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const MARKUP = /\{\{([a-z0-9_]+)(?::([a-z0-9_]+))?\|([^{}]+)\}\}/g;

function parse(src: string): Run {
  const norm = src.replace(/\s+/g, " ").trim();
  let text = "";
  const spans: Run["spans"] = [];
  let last = 0;
  for (const m of norm.matchAll(MARKUP)) {
    text += norm.slice(last, m.index);
    const t = m[3];
    if (t !== t.trim()) throw new Error(`Span text has outer whitespace: "${t}"`);
    spans.push({ s: text.length, e: text.length + t.length, key: m[1], kind: m[2] });
    text += t;
    last = (m.index ?? 0) + m[0].length;
  }
  text += norm.slice(last);
  if (text.includes("{{") || text.includes("}}") || text.includes("|}")) {
    throw new Error(`Malformed markup in: ${src.slice(0, 120)}`);
  }
  return { text, spans };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_L = 72;
const MARGIN_R = 72;
const BODY_TOP = 716;
const BODY_BOTTOM = 76;
const BODY_W = PAGE_W - MARGIN_L - MARGIN_R;
const NUMBERED_LINES = 25;
const NUM_X = 100; // right edge of deposition line numbers
const NUM_TEXT_X = 118;

interface Fonts {
  r: PDFFont;
  b: PDFFont;
  i: PDFFont;
}

interface Item {
  x: number;
  text: string;
  font: PDFFont;
  size: number;
  run?: Run;
  /** Offset of `text` within run.text. */
  at?: number;
}

interface Line {
  h: number;
  before: number;
  items: Item[];
  /** A span continues onto the next line, or the block wants to keep with next. */
  glue: boolean;
  rule?: boolean;
  forceBreak?: boolean;
  marker?: string;
}

/** Greedy wrap; returns [start, end) ranges in run.text. Breaks only at single spaces. */
function wrap(run: Run, font: PDFFont, size: number, firstW: number, restW: number, noBreakInSpans: boolean) {
  const t = run.text;
  const breakable: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== " ") continue;
    if (noBreakInSpans && run.spans.some((sp) => sp.s < i && i < sp.e)) continue;
    breakable.push(i);
  }
  breakable.push(t.length);
  const lines: [number, number][] = [];
  let start = 0;
  let prev = -1;
  const fits = (s0: number, e0: number) =>
    font.widthOfTextAtSize(t.slice(s0, e0), size) <= (lines.length === 0 ? firstW : restW);
  for (const end of breakable) {
    if (fits(start, end)) {
      prev = end;
      continue;
    }
    if (prev !== -1) {
      lines.push([start, prev]);
      start = prev + 1;
      prev = -1;
    }
    if (fits(start, end)) prev = end;
    else {
      // A single unbreakable token wider than the line: place it alone.
      lines.push([start, end]);
      start = end + 1;
    }
  }
  if (prev !== -1) lines.push([start, prev]);
  return lines.filter(([s, e]) => e > s);
}

function spanCrosses(run: Run, end: number) {
  return run.spans.some((sp) => sp.s < end && sp.e > end);
}

function measureAlign(font: PDFFont, text: string, size: number, x0: number, w: number, align: Align) {
  if (align === "left") return x0;
  const tw = font.widthOfTextAtSize(text, size);
  return align === "center" ? x0 + (w - tw) / 2 : x0 + w - tw;
}

function layoutBlocks(doc: DocSpec, fonts: Fonts): Line[] {
  const lines: Line[] = [];
  const numbered = !!doc.numbered;
  const bodyX = numbered ? NUM_TEXT_X : MARGIN_L;
  const bodyW = numbered ? PAGE_W - NUM_TEXT_X - MARGIN_R : BODY_W;

  for (const b of doc.blocks) {
    if (b.k === "break") {
      lines.push({ h: 0, before: 0, items: [], glue: false, forceBreak: true });
      continue;
    }
    if (b.k === "gap") {
      lines.push({ h: numbered ? 1 : (b.h ?? doc.size * doc.leading), before: 0, items: [], glue: false });
      continue;
    }
    if (b.k === "rule") {
      lines.push({ h: 8, before: b.before ?? 2, items: [], glue: false, rule: true });
      continue;
    }
    if (b.k === "p") {
      const size = b.size ?? doc.size;
      const font = fonts[b.font ?? "r"];
      const run = parse(b.text);
      const x0 = bodyX + (b.left ?? 0);
      const w = bodyW - (b.left ?? 0) - (b.right ?? 0);
      const indent = b.indent ?? 0;
      const firstX = indent > 0 ? x0 + indent : x0;
      const restX = indent < 0 ? x0 - indent : x0;
      const ranges = wrap(run, font, size, x0 + w - firstX, x0 + w - restX, numbered);
      ranges.forEach(([s, e], i) => {
        const text = run.text.slice(s, e);
        const lx = i === 0 ? firstX : restX;
        const x = measureAlign(font, text, size, lx, x0 + w - lx, b.align ?? "left");
        lines.push({
          h: size * doc.leading,
          before: i === 0 ? (b.before ?? (numbered ? 0 : size * 0.45)) : 0,
          items: [{ x, text, font, size, run, at: s }],
          glue: spanCrosses(run, e) || !!b.keep,
          marker: i === 0 ? b.marker : undefined,
        });
      });
      continue;
    }
    if (b.k === "kv") {
      const size = b.size ?? doc.size - 1;
      const labelW = b.labelW ?? 150;
      const x0 = bodyX + (b.left ?? 0);
      b.rows.forEach(([label, value], ri) => {
        const lrun = parse(label);
        const vrun = parse(value);
        const vw = bodyW - (b.left ?? 0) - labelW;
        const ranges = vrun.text ? wrap(vrun, fonts.r, size, vw, vw, numbered) : [];
        const first: Item[] = [];
        if (lrun.text) first.push({ x: x0, text: lrun.text, font: fonts.b, size, run: lrun, at: 0 });
        ranges.forEach(([s, e], i) => {
          const item: Item = { x: x0 + labelW, text: vrun.text.slice(s, e), font: fonts.r, size, run: vrun, at: s };
          const glue = spanCrosses(vrun, e);
          if (i === 0) {
            first.push(item);
            lines.push({ h: size * 1.45, before: ri === 0 ? (b.before ?? 4) : 0, items: first, glue });
          } else {
            lines.push({ h: size * 1.45, before: 0, items: [item], glue });
          }
        });
        if (ranges.length === 0) lines.push({ h: size * 1.45, before: ri === 0 ? (b.before ?? 4) : 0, items: first, glue: false });
      });
      continue;
    }
    if (b.k === "table") {
      const size = b.size ?? doc.size - 2;
      const rowsAll = b.head ? [b.head, ...b.rows] : b.rows;
      rowsAll.forEach((row, ri) => {
        const isHead = !!b.head && ri === 0;
        const font = isHead ? fonts.b : fonts.r;
        const items: Item[] = [];
        row.forEach((cell, ci) => {
          const run = parse(cell);
          if (!run.text) return;
          const col = b.cols[ci];
          const nextX = ci + 1 < b.cols.length ? b.cols[ci + 1].x : bodyW;
          let x = bodyX + col.x;
          if (col.align === "right") x = bodyX + nextX - 6 - font.widthOfTextAtSize(run.text, size);
          items.push({ x, text: run.text, font, size, run, at: 0 });
        });
        lines.push({ h: size * 1.55, before: ri === 0 ? (b.before ?? 6) : 0, items, glue: isHead });
      });
      continue;
    }
    if (b.k === "caption") {
      const size = b.size ?? doc.size;
      b.rows.forEach(([l, r], ri) => {
        const items: Item[] = [];
        const lr = parse(l);
        const rr = parse(r);
        if (lr.text) items.push({ x: bodyX, text: lr.text, font: fonts.b, size, run: lr, at: 0 });
        items.push({ x: bodyX + 262, text: "*", font: fonts.r, size });
        if (rr.text) items.push({ x: bodyX + 290, text: rr.text, font: fonts.b, size, run: rr, at: 0 });
        lines.push({ h: size * 1.4, before: ri === 0 ? (b.before ?? 4) : 0, items, glue: ri < b.rows.length - 1 });
      });
      continue;
    }
  }
  return lines;
}

interface PlacedLine {
  line: Line;
  baseline: number;
  slot?: number;
}

function paginate(doc: DocSpec, lines: Line[]): PlacedLine[][] {
  const pages: PlacedLine[][] = [[]];
  if (doc.numbered) {
    const slotH = (BODY_TOP - BODY_BOTTOM) / NUMBERED_LINES;
    let slot = 0;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.forceBreak) {
        if (slot > 0) {
          pages.push([]);
          slot = 0;
        }
        continue;
      }
      // Keep glued groups together.
      let j = i;
      while (j < lines.length - 1 && lines[j].glue && !lines[j + 1].forceBreak) j++;
      const groupSlots = j - i + 1;
      if (slot + groupSlots > NUMBERED_LINES && slot > 0 && groupSlots <= NUMBERED_LINES) {
        pages.push([]);
        slot = 0;
      }
      if (slot >= NUMBERED_LINES) {
        pages.push([]);
        slot = 0;
      }
      pages[pages.length - 1].push({ line: ln, baseline: BODY_TOP - (slot + 1) * slotH + slotH * 0.3, slot });
      slot++;
    }
    return pages;
  }

  let y = BODY_TOP;
  const atTop = () => pages[pages.length - 1].length === 0;
  const newPage = () => {
    pages.push([]);
    y = BODY_TOP;
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.forceBreak) {
      if (!atTop()) newPage();
      continue;
    }
    let j = i;
    let need = (atTop() ? 0 : ln.before) + ln.h;
    while (j < lines.length - 1 && lines[j].glue && !lines[j + 1].forceBreak) {
      j++;
      need += lines[j].before + lines[j].h;
    }
    if (y - need < BODY_BOTTOM && !atTop() && need <= BODY_TOP - BODY_BOTTOM) newPage();
    else if (y - (atTop() ? 0 : ln.before) - ln.h < BODY_BOTTOM && !atTop()) newPage();
    if (!atTop()) y -= ln.before;
    const size = ln.items[0]?.size ?? 10;
    const baseline = y - size;
    y -= ln.h;
    pages[pages.length - 1].push({ line: ln, baseline });
  }
  return pages.filter((pg, idx) => pg.length > 0 || idx === 0);
}

// ---------------------------------------------------------------------------
// Entities & span classification
// ---------------------------------------------------------------------------

const ENTITIES: Entity[] = [];
const ent = (e: Entity) => ENTITIES.push(e);

const KEEP_KEYS: Record<string, { category: Category; kind?: string }> = {
  cite: { category: "citation" },
  month: { category: "decoy_word", kind: "month" },
  modal: { category: "decoy_word", kind: "modal_verb" },
  word: { category: "decoy_word" },
  num: { category: "decoy_number" },
};

const HONORIFICS: Record<string, (e: Entity) => boolean> = {
  "mr.": (e) => e.gender === "m" && !e.minor,
  "mrs.": (e) => e.gender === "f" && !e.minor,
  "ms.": (e) => e.gender === "f" && !e.minor,
  "miss": (e) => e.gender === "f",
  "dr.": () => true,
  "officer": (e) => e.official === "police",
  "ofc.": (e) => e.official === "police",
  "det.": (e) => e.official === "police",
  "detective": (e) => e.official === "police",
  "judge": (e) => e.official === "judge",
};

/** A person mention is ambiguous when, after stripping an honorific and a possessive,
 *  it is a bare surname shared by 2+ people compatible with the honorific. */
function isAmbiguous(text: string): boolean {
  let t = text.trim().replace(/'s$/i, "").replace(/'$/, "");
  let filter: (e: Entity) => boolean = () => true;
  for (const [hon, f] of Object.entries(HONORIFICS)) {
    if (t.toLowerCase().startsWith(hon + " ")) {
      t = t.slice(hon.length + 1).trim();
      filter = f;
      break;
    }
  }
  const people = ENTITIES.filter(
    (e) => e.type === "person" && e.surname && e.surname.toLowerCase() === t.toLowerCase() && filter(e),
  );
  return people.length >= 2;
}

function classify(key: string, kind: string | undefined, text: string) {
  const keep = KEEP_KEYS[key];
  if (keep) {
    return { expected: "keep" as Expected, category: keep.category, kind: kind ?? keep.kind };
  }
  const e = ENTITIES.find((x) => x.key === key);
  if (!e) throw new Error(`Unknown markup key "${key}" (text: "${text}")`);
  let category: Category;
  if (e.type === "person") category = e.redact ? "person" : "official";
  else if (e.type === "org") category = "org";
  else if (e.type === "address") category = "address";
  else category = /[X*]/.test(text) || text.replace(/\D/g, "").length < 9 ? "ssn_partial" : "ssn";
  const ambiguous = e.type === "person" && isAmbiguous(text);
  return { expected: (e.redact ? "redact" : "keep") as Expected, category, entityId: e.id, ambiguous, kind };
}

// ---------------------------------------------------------------------------
// Cast (all fictional). Matter: State of Maryland v. John A. Smith,
// Circuit Court for Baltimore City, Case No. 24-CR-004512.
//
// Story: John Smith, operations manager at Acme Logistics' Holabird Avenue
// warehouse, allegedly approved $63,450 in invoices from a sham vendor
// ("Patapsco Freight Services") paid into a Chesapeake Federal Bank account he
// controlled. Coworker Will Marsh flagged the invoices on April 29, 2024. On the
// night of May 3, 2024, someone used John's badge to enter the warehouse office,
// took the vendor binders, and shoved security guard Darnell Price down a
// stairwell. Defense alibi: John was at a pediatric urgent care with his
// granddaughter E.S. Neighbor May Chen saw "Mr. Smith" drive off in John's
// pickup -- but John's son Steve had borrowed the truck that night.
// ---------------------------------------------------------------------------

// Private people (REDACT)
ent({ key: "john", id: "john_smith", type: "person", canonical: "John A. Smith", redact: true, note: "defendant; 'Johnny' to coworkers", surname: "Smith", gender: "m" });
ent({ key: "steve", id: "steve_smith", type: "person", canonical: "Stephen M. Smith", redact: true, note: "defendant's adult son; key witness (deposed)", surname: "Smith", gender: "m" });
ent({ key: "emily", id: "emily_smith", type: "person", canonical: "Emily R. Smith", redact: true, note: "minor (age 7); defendant's granddaughter, Steve's daughter; usually 'E.S.'", surname: "Smith", gender: "f", minor: true });
ent({ key: "mary", id: "mary_smith", type: "person", canonical: "Mary E. Smith", redact: true, note: "defendant's wife; joint account holder", surname: "Smith", gender: "f" });
ent({ key: "may", id: "may_chen", type: "person", canonical: "May Chen", redact: true, note: "next-door neighbor; eyewitness (first name collides with the month)", surname: "Chen", gender: "f" });
ent({ key: "will", id: "will_marsh", type: "person", canonical: "William Marsh", redact: true, note: "coworker/shift supervisor who reported the invoices (first name collides with the verb)", surname: "Marsh", gender: "m" });
ent({ key: "carla", id: "carla_marsh", type: "person", canonical: "Carla Marsh", redact: true, note: "Will Marsh's wife (alibi for Will); makes bare 'Marsh' ambiguous", surname: "Marsh", gender: "f" });
ent({ key: "price", id: "darnell_price", type: "person", canonical: "Darnell Price", redact: true, note: "victim; night security guard (surname collides with the noun)", surname: "Price", gender: "m" });
ent({ key: "rosa", id: "rosa_delgado", type: "person", canonical: "Rosa Delgado", redact: true, note: "bank teller; witness", surname: "Delgado", gender: "f" });
ent({ key: "kara", id: "kara_delaney", type: "person", canonical: "Kara Delaney", redact: true, note: "E.S.'s mother (Steve's former partner)", surname: "Delaney", gender: "f" });
ent({ key: "pruitt", id: "linda_pruitt", type: "person", canonical: "Linda Pruitt", redact: true, note: "Acme HR records custodian -- private individual under the residual rule (not on the KEEP list)", surname: "Pruitt", gender: "f" });
ent({ key: "rao", id: "anand_rao", type: "person", canonical: "Anand Rao", redact: true, note: "urgent-care physician -- private individual under the residual rule (not on the KEEP list)", surname: "Rao", gender: "m" });

// Home addresses (REDACT)
ent({ key: "addr_smith", id: "addr_smith_home", type: "address", canonical: "1418 Elm Street, Baltimore, MD 21218", redact: true, note: "John & Mary Smith residence (E.S. stays here)" });
ent({ key: "addr_steve", id: "addr_steve_home", type: "address", canonical: "3306 Linden Court, Apt. 2B, Towson, MD 21204", redact: true, note: "Steve Smith residence" });
ent({ key: "addr_chen", id: "addr_chen_home", type: "address", canonical: "1420 Elm Street, Baltimore, MD 21218", redact: true, note: "May Chen residence (next door; same street as the Smiths)" });
ent({ key: "addr_price", id: "addr_price_home", type: "address", canonical: "617 Pelham Avenue, Baltimore, MD 21213", redact: true, note: "Darnell Price residence" });
ent({ key: "addr_marsh", id: "addr_marsh_home", type: "address", canonical: "52 Harbor View Lane, Dundalk, MD 21222", redact: true, note: "Will Marsh residence (letter return address)" });

// SSNs (REDACT) -- valid-format, fictional
ent({ key: "ssn_john", id: "ssn_john", type: "ssn", canonical: "212-48-6789", redact: true, note: "John A. Smith" });
ent({ key: "ssn_steve", id: "ssn_steve", type: "ssn", canonical: "219-63-4102", redact: true, note: "Stephen M. Smith" });
ent({ key: "ssn_mary", id: "ssn_mary", type: "ssn", canonical: "223-41-4417", redact: true, note: "Mary E. Smith" });
ent({ key: "ssn_price", id: "ssn_price", type: "ssn", canonical: "578-20-3391", redact: true, note: "Darnell Price" });

// Keep-side people
ent({ key: "judge", id: "judge_alvarez", type: "person", canonical: "Hon. Patricia Alvarez", redact: false, note: "presiding judge", surname: "Alvarez", gender: "f", official: "judge" });
ent({ key: "asa", id: "asa_whitfield", type: "person", canonical: "Marcus Whitfield", redact: false, note: "Assistant State's Attorney (attorney of record)", surname: "Whitfield", gender: "m", official: "attorney" });
ent({ key: "okafor", id: "atty_okafor", type: "person", canonical: "Lauren Okafor", redact: false, note: "defense counsel (attorney of record)", surname: "Okafor", gender: "f", official: "attorney" });
ent({ key: "det", id: "det_kowalski", type: "person", canonical: "Det. Brian Kowalski", redact: false, note: "BPD detective acting officially", surname: "Kowalski", gender: "m", official: "police" });
ent({ key: "ofc_chen", id: "ofc_chen", type: "person", canonical: "Officer Kevin Chen", redact: false, note: "BPD responding officer acting officially -- shares a surname with May Chen (no relation)", surname: "Chen", gender: "m", official: "police" });
ent({ key: "reporter", id: "reporter_harmon", type: "person", canonical: "Denise Harmon", redact: false, note: "court reporter (court staff)", surname: "Harmon", gender: "f", official: "court_staff" });
ent({ key: "clerk", id: "clerk_ferris", type: "person", canonical: "Andrea Ferris", redact: false, note: "courtroom clerk (court staff)", surname: "Ferris", gender: "f", official: "court_staff" });

// Organizations (KEEP)
ent({ key: "acme", id: "org_acme", type: "org", canonical: "Acme Logistics LLC", redact: false, note: "defendant's employer; theft victim" });
ent({ key: "cfb", id: "org_cfb", type: "org", canonical: "Chesapeake Federal Bank", redact: false, note: "bank" });
ent({ key: "bpd", id: "org_bpd", type: "org", canonical: "Baltimore Police Department", redact: false, note: "police" });
ent({ key: "court", id: "org_court", type: "org", canonical: "Circuit Court for Baltimore City", redact: false, note: "court" });
ent({ key: "sao", id: "org_sao", type: "org", canonical: "Office of the State's Attorney for Baltimore City", redact: false, note: "prosecutor's office" });
ent({ key: "firm", id: "org_firm", type: "org", canonical: "Okafor & Reyes LLP", redact: false, note: "defense law firm" });
ent({ key: "clinic", id: "org_clinic", type: "org", canonical: "Harbor Pediatric Urgent Care", redact: false, note: "urgent-care clinic" });
ent({ key: "ironclad", id: "org_ironclad", type: "org", canonical: "Ironclad Security Services", redact: false, note: "victim's employer (security contractor)" });
ent({ key: "patapsco", id: "org_patapsco", type: "org", canonical: "Patapsco Freight Services", redact: false, note: "alleged sham vendor (a business name, not a person)" });
ent({ key: "harmon_cr", id: "org_harmon_cr", type: "org", canonical: "Harmon Court Reporting, LLC", redact: false, note: "court-reporting firm" });
ent({ key: "sw", id: "org_sw", type: "org", canonical: "Smith & Wesson", redact: false, note: "firearm brand -- contains 'Smith'" });

// Business / public addresses (KEEP)
ent({ key: "b_acme", id: "addr_acme_hq", type: "address", canonical: "2300 Smith Avenue, Baltimore, MD 21209", redact: false, note: "Acme headquarters -- business address on a street named 'Smith'" });
ent({ key: "b_warehouse", id: "addr_acme_warehouse", type: "address", canonical: "4900 Holabird Avenue, Baltimore, MD 21224", redact: false, note: "Acme warehouse (crime scene) -- business address" });
ent({ key: "b_court", id: "addr_courthouse", type: "address", canonical: "100 N. Calvert Street, Baltimore, MD 21202", redact: false, note: "courthouse" });
ent({ key: "b_cfb", id: "addr_cfb", type: "address", canonical: "25 S. Charles Street, Suite 900, Baltimore, MD 21201-3456", redact: false, note: "bank legal-process office" });
ent({ key: "b_branch", id: "addr_cfb_branch", type: "address", canonical: "3400 Eastern Avenue, Baltimore, MD 21224", redact: false, note: "bank branch" });
ent({ key: "b_firm", id: "addr_firm", type: "address", canonical: "201 N. Charles Street, Suite 1400, Baltimore, MD 21201", redact: false, note: "defense law firm" });
ent({ key: "b_sao", id: "addr_sao", type: "address", canonical: "120 E. Baltimore Street, Baltimore, MD 21202", redact: false, note: "prosecutor's office" });
ent({ key: "b_bpd", id: "addr_bpd", type: "address", canonical: "5710 Eastern Avenue, Baltimore, MD 21224", redact: false, note: "police district station" });
ent({ key: "b_clinic", id: "addr_clinic", type: "address", canonical: "1100 S. Conkling Street, Baltimore, MD 21224", redact: false, note: "urgent-care clinic" });

// Shared header/footer helpers
const CASE_NO = "{{num:case_number|24-CR-004512}}";
const pageOf = (n: number, t: number): HeaderLine[] => [{ center: `Page ${n} of ${t}` }];
const pleadingHeader = (short: string) => (): HeaderLine[] => [
  { left: `State v. {{john|John A. Smith}}`, right: `Case No. ${CASE_NO}` },
  { left: short },
];

// ---------------------------------------------------------------------------
// 01 Charging document (criminal information + statement of probable cause)
// ---------------------------------------------------------------------------
DOCS.push({
  file: "01-charging-document.pdf",
  title: "Criminal Information",
  size: 11.5,
  leading: 1.9,
  header: pleadingHeader("Criminal Information"),
  footer: pageOf,
  blocks: [
    caption([
      ["STATE OF MARYLAND", "IN THE"],
      ["", "CIRCUIT COURT"],
      ["v.", "FOR"],
      ["{{john|JOHN ANDREW SMITH}}", "BALTIMORE CITY"],
      ["{{addr_smith|1418 Elm Street}}", ""],
      ["Baltimore, Maryland 21218", `Case No. ${CASE_NO}`],
      ["Defendant.", ""],
    ]),
    p("* * * * * * * * * * * * * * * * * * * * * *", { align: "center", before: 6 }),
    h("CRIMINAL INFORMATION"),
    p(
      `The {{sao|Office of the State's Attorney for Baltimore City}}, by Assistant State's Attorney {{asa|Marcus Whitfield}}, charges that
      the Defendant, {{john|John Andrew Smith}} (DOB {{num:dob|03/14/1963}}; SID {{num:sid|4418207}}), whose last known residence is
      {{addr_smith|1418 Elm Street, Baltimore, Maryland 21218}}, committed the following offenses in Baltimore City, State of Maryland:`,
      { indent: 36 },
    ),
    sh("COUNT ONE -- Theft Scheme ($25,000 to under $100,000)"),
    p(
      `Between on or about January 8, 2024 and on or about April 26, 2024, the Defendant, {{john|John Andrew Smith}}, pursuant to one
      scheme and continuing course of conduct, did willfully and knowingly obtain unauthorized control over money of
      {{acme|Acme Logistics LLC}}, having a value of at least $25,000 but less than $100,000, to wit: $63,450.00, with the intent to
      deprive the owner of that property, in violation of Md. Code Ann., Crim. Law § 7-104, against the peace, government, and dignity
      of the State.`,
      { indent: 36 },
    ),
    sh("COUNT TWO -- Assault in the Second Degree"),
    p(
      `On or about {{month|May 3, 2024}}, the Defendant, {{john|John Andrew Smith}}, did assault {{price|Darnell Price}}, in violation of
      Md. Code Ann., Crim. Law § 3-203, against the peace, government, and dignity of the State.`,
      { indent: 36 },
    ),
    sh("COUNT THREE -- Burglary in the Fourth Degree"),
    p(
      `On or about {{month|May 3, 2024}}, the Defendant, {{john|John Andrew Smith}}, did break and enter the storehouse of
      {{acme|Acme Logistics LLC}}, located at {{b_warehouse|4900 Holabird Avenue, Baltimore, MD 21224}}, in violation of Md. Code
      Ann., Crim. Law § 6-205(b), against the peace, government, and dignity of the State.`,
      { indent: 36 },
    ),
    h("STATEMENT OF PROBABLE CAUSE", { before: 16 }),
    p(
      `1. {{acme|Acme Logistics LLC}} ("Acme") is a freight and warehousing company headquartered at {{b_acme|2300 Smith Avenue,
      Baltimore, MD 21209}}. Since 2002 the Defendant has worked at Acme's distribution warehouse on Holabird Avenue, most recently as
      Operations Manager. In that role {{john|Mr. Smith}} had authority to approve vendor invoices of up to $10,000 without a second
      signature.`,
      { indent: 36 },
    ),
    p(
      `2. Between January and April 2024, {{john|Mr. Smith}} approved fourteen invoices from a vendor called
      {{patapsco|Patapsco Freight Services}}, each between $3,900 and $5,200, for "overflow trailer drayage." Acme has no record that
      any drayage was performed. All fourteen payments, totaling $63,450.00, were sent by ACH to a business checking account at
      {{cfb|Chesapeake Federal Bank}} ending in {{num:account|5510}}.`,
      { indent: 36 },
    ),
    p(
      `3. Records produced by {{cfb|Chesapeake Federal Bank}} show that the account was opened on December 18, 2023 by
      {{john|John A. Smith}}, doing business as {{patapsco|Patapsco Freight Services}}, using a Social Security number ending in
      {{ssn_john|6789}}, and listing the Defendant's home at {{addr_smith|1418 Elm Street}} as the business address. The
      Defendant's wife, {{mary|Mary E. Smith}}, is listed as a joint signer. Teller {{rosa|Rosa Delgado}} of the Eastern Avenue
      branch processed eleven cash withdrawals from the account, and identified the Defendant from a photo array as the person who
      made them.`,
      { indent: 36 },
    ),
    p(
      `4. On April 29, 2024, Acme shift supervisor {{will|William Marsh}} reported the {{patapsco|Patapsco}} invoices to Acme's
      compliance office. {{will|Mr. Marsh}} told investigators that the Defendant learned of the report the following day and
      asked him "what exactly {{will|Will}} thought he had seen." Acme suspended the Defendant's approval authority on
      {{month|May 1, 2024}}, but did not deactivate his building access badge.`,
      { indent: 36 },
    ),
    p(
      `5. At approximately 10:38 P.M. on {{month|May 3, 2024}}, the Defendant's badge (No. {{num:badge|A-20417}}) was used to open the
      rear dock door and the second-floor operations office of the warehouse. Security officer {{price|Darnell Price}}, an employee
      of {{ironclad|Ironclad Security Services}} assigned to the site, heard a filing cabinet being forced and went upstairs. The
      intruder pushed {{price|Mr. Price}} down the office stairwell and fled through the dock door. {{price|Mr. Price}} sustained a
      fractured left wrist. Two binders of vendor files, including all {{patapsco|Patapsco Freight}} paperwork, were missing.`,
      { indent: 36 },
    ),
    p(
      `6. {{price|Mr. Price}} described the intruder as a white male, heavyset, wearing a dark Orioles cap. A neighbor of the
      Defendant, {{may|May Chen}}, of {{addr_chen|1420 Elm Street}}, told police that she saw "{{john|Mr. Smith}}" leave the
      {{addr_smith|Elm Street}} house in the Defendant's silver pickup truck shortly after 10:00 P.M. and return before midnight.
      Travel time from the residence to the warehouse is approximately nineteen minutes.`,
      { indent: 36 },
    ),
    p(
      `7. When interviewed on {{month|May 6, 2024}}, the Defendant denied entering the warehouse and stated that he spent the evening
      at an urgent-care clinic with his granddaughter, a minor identified here as {{emily|E.S.}} The Defendant stated that his son,
      {{steve|Stephen M. Smith}}, may have used the pickup truck that night. Based on the foregoing, there is probable cause to
      believe that the Defendant committed the offenses charged.`,
      { indent: 36 },
    ),
    gap(8),
    p("Respectfully submitted,", { left: 252 }),
    p("/s/ {{asa|Marcus Whitfield}}", { left: 252, before: 14 }),
    p("{{asa|Marcus Whitfield}}, AIS No. {{num:bar|0912170044}}", { left: 252, before: 0, size: 10.5 }),
    p("Assistant State's Attorney", { left: 252, before: 0, size: 10.5 }),
    p("{{sao|Office of the State's Attorney for Baltimore City}}", { left: 252, before: 0, size: 10.5 }),
    p("{{b_sao|120 E. Baltimore Street, Baltimore, MD 21202}}", { left: 252, before: 0, size: 10.5 }),
    p("Tel. {{num:phone|(410) 555-0142}}", { left: 252, before: 0, size: 10.5 }),
    p("Filed: {{month|May 14, 2024}}", { before: 14, size: 10.5 }),
  ],
});

// ---------------------------------------------------------------------------
// 02 Police incident report (forms + narrative + detective supplement)
// ---------------------------------------------------------------------------
DOCS.push({
  file: "02-police-incident-report.pdf",
  title: "Police Incident Report",
  size: 10,
  leading: 1.5,
  header: () => [
    { left: "{{bpd|BALTIMORE POLICE DEPARTMENT}}", right: "INCIDENT / OFFENSE REPORT" },
    { left: "Southeastern District", right: "Complaint No. {{num:complaint|24-5E-018734}}" },
  ],
  footer: (n, t) => [{ left: "BPD Form 1001 (Rev. 03/2022)", right: `Page ${n} of ${t}` }],
  blocks: [
    sh("SECTION 1 -- INCIDENT", { before: 0 }),
    rule(),
    kv([
      ["Date / Time Reported:", "05/03/2024 22:51 hrs"],
      ["Date / Time Occurred:", "05/03/2024 approx. 22:38 hrs"],
      ["Location of Occurrence:", "{{acme|Acme Logistics LLC}} warehouse, {{b_warehouse|4900 Holabird Avenue, Baltimore, MD 21224}}"],
      ["Premises Type:", "Commercial / warehouse (second-floor operations office)"],
      ["Offense(s):", "Burglary 4th Degree (CR 6-205); Assault 2nd Degree (CR 3-203); Theft (CR 7-104)"],
      ["Reporting Officer:", "{{ofc_chen|Ofc. Kevin Chen}}, #{{num:badge|4471}}, Sector 2"],
      ["Assisting Unit(s):", "Car 5E23; BCFD Medic 21"],
      ["Case Status:", "Open -- referred to Southeastern District Detective Unit"],
    ]),
    sh("SECTION 2 -- VICTIM(S)"),
    rule(),
    kv([
      ["V-1 Name:", "{{price|PRICE, DARNELL T.}}"],
      ["Date of Birth:", "{{num:dob|07/19/1979}} (44)"],
      ["Sex / Race:", "M / B"],
      ["SSN:", "{{ssn_price|578-20-3391}}"],
      ["Home Address:", "{{addr_price|617 Pelham Avenue, Baltimore, MD 21213}}"],
      ["Phone:", "{{num:phone|(443) 555-0186}}"],
      ["Employer:", "{{ironclad|Ironclad Security Services}} (contract security, site post #2)"],
      ["Injury:", "Suspected fracture, left wrist; abrasions to forehead. Transported by Medic 21."],
      ["V-2 Name:", "{{acme|Acme Logistics LLC}} (business), {{b_acme|2300 Smith Avenue, Baltimore, MD 21209}}"],
      ["Business Phone:", "{{num:phone|(410) 555-0120}} -- EIN {{num:ein|52-1234567}}"],
    ]),
    sh("SECTION 3 -- WITNESS(ES) / OTHER PERSONS"),
    rule(),
    kv([
      ["W-1 Name:", "{{will|MARSH, WILLIAM J.}} (on-call shift supervisor, {{acme|Acme}})"],
      ["Contact:", "{{num:phone|(410) 555-0164}} (cell)"],
      ["Role:", "Arrived on scene 23:20 hrs; identified missing records"],
    ]),
    sh("SECTION 4 -- PROPERTY"),
    rule(),
    table({
      cols: [{ x: 0 }, { x: 40 }, { x: 300 }, { x: 390, align: "right" }],
      head: ["Item", "Description", "Status", "Value"],
      rows: [
        ["1", "Vendor binder, {{patapsco|Patapsco Freight Services}} (2023-24)", "Stolen", "N/A"],
        ["2", "Vendor binder, misc. carriers A-M", "Stolen", "N/A"],
        ["3", "Dell Latitude laptop, asset tag {{num:asset_tag|ACM-11872}}", "Stolen", "$1,240.00"],
        ["4", "Filing cabinet, 4-drawer (lock forced)", "Damaged", "$310.00"],
      ],
    }),
    sh("SECTION 5 -- NARRATIVE (Reporting Officer)"),
    rule(),
    p(
      `On {{month|May 3, 2024}} at approximately 22:51 hrs, R/O {{ofc_chen|Ofc. K. Chen}} responded to the {{acme|Acme Logistics}}
      warehouse at {{b_warehouse|4900 Holabird Avenue}} for a report of a burglary in progress with an injured security guard. Upon
      arrival R/O met the victim, {{price|Darnell Price}}, seated at the base of the interior stairwell holding his left arm.
      {{price|Mr. Price}} stated that he is a security officer for {{ironclad|Ironclad Security Services}} and was conducting his
      22:30 rounds when he heard metal scraping from the second-floor operations office, which is normally locked after 18:00.`,
    ),
    p(
      `{{price|Mr. Price}} stated he climbed the stairs and saw an unknown male pulling folders out of a filing cabinet. The male turned
      off the overhead light, rushed toward the door, and shoved {{price|Price}} with both hands. {{price|Price}} fell backward down
      approximately eight steps and struck his head and wrist. He stated the male ran down past him and out the rear dock door.
      {{price|Price}} stated that his duty weapon, a {{sw|Smith & Wesson}} M&P 9 pistol, remained holstered throughout and that
      he did not draw it because "it happened in about two seconds."`,
    ),
    p(
      `{{price|Price}} described the suspect as a white male, 55 to 65 years old, approximately 5'10", heavy build, wearing a dark
      Orioles baseball cap, dark jacket, and work boots. He did not see the suspect's face clearly. {{price|Price}} stated he would
      not be able to make an identification but "the guy knew exactly where he was going." BCFD Medic 21 evaluated
      {{price|Mr. Price}} on scene and transported him for treatment of a suspected fractured wrist.`,
    ),
    p(
      `R/O observed that the rear dock door (Door D-4) was closed but unlocked. The operations office door showed no signs of force.
      The top two drawers of a four-drawer filing cabinet had been pried open; a flat-head screwdriver was recovered from the floor
      and submitted to ECU as Item 5 for latent prints. At 23:20 hrs the on-call shift supervisor, {{will|William Marsh}}, arrived and
      reviewed the office. {{will|Mr. Marsh}} stated that two vendor binders were missing, including the binder for
      {{patapsco|Patapsco Freight Services}}, a vendor he had recently reported to {{acme|Acme}} compliance for suspected billing
      irregularities. {{will|Marsh}} stated that a company laptop was also missing; he estimated its replacement
      {{word:common_noun|price}} at about $1,240.`,
    ),
    p(
      `{{will|Mr. Marsh}} advised that door access is controlled by employee badges and that the access-control vendor will be able
      to produce a log for the evening. {{will|Marsh}} stated, "I will pull whatever you need." R/O requested that the log be
      preserved. Scene was processed by ECU Technician #8812. No further information at this time.`,
    ),
    p("Reporting Officer: {{ofc_chen|Ofc. Kevin Chen}} #{{num:badge|4471}}  Date: 05/04/2024 01:12 hrs", { before: 8, font: "b" }),
    pageBreak(),
    sh("SECTION 6 -- SUSPECT", { before: 0 }),
    rule(),
    kv([
      ["S-1 Name:", "{{john|SMITH, JOHN ANDREW}}"],
      ["Date of Birth:", "{{num:dob|03/14/1963}} (61)"],
      ["Sex / Race / Ht / Wt:", "M / W / 5'10\" / 230 lbs"],
      ["SSN:", "{{ssn_john|212 48 6789}}"],
      ["Home Address:", "{{addr_smith|1418 Elm Street, Baltimore, MD 21218}}"],
      ["Phone:", "{{num:phone|(410) 555-0173}}"],
      ["Employer:", "{{acme|Acme Logistics LLC}} -- Operations Manager (badge No. {{num:badge|A-20417}})"],
      ["Vehicle:", "2019 Ford F-150, silver, MD tag {{num:plate|4CX-7219}}, registered to {{john|John A. Smith}} and {{mary|Mary E. Smith}}"],
    ]),
    sh("SECTION 7 -- SUPPLEMENT (Investigating Detective)"),
    rule(),
    p(
      `On {{month|May 4, 2024}}, this investigator, {{det|Det. Brian Kowalski}}, Southeastern District Detective Unit, was assigned
      this complaint. I reviewed the reporting officer's narrative and spoke by phone with the victim, {{price|Darnell Price}}, who
      confirmed his account. {{price|Mr. Price}} was treated and released with a splinted fracture of the left distal radius.`,
    ),
    p(
      `Badge log. On {{month|May 4, 2024}}, {{acme|Acme}} security produced the door-access log for {{month|May 3, 2024}}. The log
      shows badge No. {{num:badge|A-20417}}, assigned to {{john|John A. Smith}}, granted at Door D-4 (rear dock) at 22:37:52 hrs and at
      the operations office (Door O-2) at 22:38:41 hrs. No other badge was used at either door between 18:10 hrs and 23:19 hrs, when
      {{will|Marsh}} badged in. {{acme|Acme}} confirmed that {{john|SMITH's}} approval authority had been suspended on
      {{month|May 1, 2024}} pending an audit, but his badge remained active.`,
    ),
    p(
      `Neighbor canvass. On {{month|May 4, 2024}} at 14:20 hrs, I interviewed {{may|May Chen}}, who resides at
      {{addr_chen|1420 Elm Street}}, next door to the suspect's residence. ({{may|Ms. Chen}} is no relation to
      {{ofc_chen|Ofc. Chen}}.) {{may|Chen}} stated that at about 22:05 hrs on {{month|May 3}} she was putting out her trash and saw
      the silver pickup truck belonging to "{{john|Mr. Smith}}" back out of the {{addr_smith|1418 Elm Street}} driveway. She stated
      the driver was wearing a baseball cap. She stated she heard the truck return "a little before midnight" and saw
      "{{john|Mr. Smith}}" walk from the truck into the side door. When asked which {{john|Mr. Smith}} she meant, {{may|Chen}}
      stated, "{{john|John}}, the father. {{steve|Steve}} doesn't live there anymore." She acknowledged that it was dark and that she
      saw the driver only from behind. A written statement was obtained (see attached).`,
    ),
    p(
      `Bank records. Acme's internal audit identified fourteen ACH payments to {{patapsco|Patapsco Freight Services}} deposited to
      {{cfb|Chesapeake Federal Bank}} account ending {{num:account|5510}}, routing No. {{num:routing|052000113}}. On
      {{month|May 9, 2024}} I interviewed teller {{rosa|Rosa Delgado}} at the bank's {{b_branch|3400 Eastern Avenue}} branch.
      {{rosa|Ms. Delgado}} stated that a regular customer she knew as "{{john|Mr. Smith}}" made cash withdrawals from the
      {{patapsco|Patapsco}} account roughly every two weeks and once remarked that he was "saving for his granddaughter's school."
      {{rosa|Delgado}} selected {{john|SMITH's}} photograph from a six-person array (administered blind by {{ofc_chen|Ofc. Chen}}) and
      stated she was "about ninety percent sure." A subpoena for account records was requested through the
      {{sao|State's Attorney's Office}}.`,
    ),
    p(
      `Suspect interview. On {{month|May 6, 2024}} at 10:05 hrs, {{john|John A. Smith}} appeared voluntarily at the Southeastern District,
      {{b_bpd|5710 Eastern Avenue, Baltimore, MD 21224}}. He was advised of his rights, waived them in writing, and agreed to speak.
      {{john|SMITH}} denied entering the warehouse on {{month|May 3}}. He stated that at approximately 21:30 hrs his granddaughter,
      {{emily|E.S.}} (age 7), who was staying with him and his wife, developed a high fever, and that he drove her to
      {{clinic|Harbor Pediatric Urgent Care}} in his wife's gray Honda Accord, leaving his truck in the driveway. He stated they
      returned home after 23:30 hrs. {{john|SMITH}} stated that his son, {{steve|Stephen M. Smith}}, was at the house that evening and
      "might have taken the truck to get {{emily|Emmy's}} medicine." He stated his keys and badge lanyard hang on a hook by the kitchen door.`,
    ),
    p(
      `{{john|SMITH}} denied any knowledge of {{patapsco|Patapsco Freight Services}} and stated, "Whatever account that is, I didn't
      open it." When shown the account-opening documents bearing his name, Social Security number ending {{ssn_john|6789}}, and home
      address, {{john|SMITH}} stated, "That's my information, but that's not my signature," and ended the interview at 10:52 hrs.`,
    ),
    p(
      `Follow-up. I contacted {{steve|Stephen M. Smith}} (DOB {{num:dob|08/22/1988}}) of
      {{addr_steve|3306 Linden Court, Apt. 2B, Towson, MD 21204}} by phone on {{month|May 7, 2024}}. {{steve|Steve Smith}} confirmed he
      was at his parents' house on the evening of {{month|May 3}} and stated he would give a full statement only with counsel present.
      Defense counsel later advised that {{steve|Mr. Smith}} will be relocating overseas for work in June, and the parties agreed to
      preserve his testimony by deposition. I also spoke with {{mary|Mary Smith}}, who confirmed that her husband took
      {{emily|E.S.}} to urgent care in her car. {{mary|Mrs. Smith}} stated she was asleep by 22:00 hrs and does not know who
      used the truck. Case remains open pending bank records and latent print results.`,
    ),
    p("Investigating Detective: {{det|Det. Brian Kowalski}} #{{num:badge|3196}}  Date: 05/10/2024", { before: 8, font: "b" }),
    p("Approved: Southeastern District Detective Unit Supervisor -- 05/10/2024", { size: 9 }),
  ],
});

// ---------------------------------------------------------------------------
// 03 Deposition of Stephen M. Smith (volume test; numbered transcript lines)
// "Mr. Smith" here usually means the WITNESS (Steve); a few uses mean the
// defendant (John). Context decides.
// ---------------------------------------------------------------------------
const WIT = "{{asa|MR. WHITFIELD}}";
const OKA = "{{okafor|MS. OKAFOR}}";
const DEPO: Block[] = [
  p("IN THE {{court|CIRCUIT COURT FOR BALTIMORE CITY}}, MARYLAND", { align: "center", font: "b" }),
  gap(),
  caption([
    ["STATE OF MARYLAND,", ""],
    ["Plaintiff,", ""],
    ["v.", `Case No. ${CASE_NO}`],
    ["{{john|JOHN A. SMITH}},", ""],
    ["Defendant.", ""],
  ]),
  gap(),
  p("* * * * * * * * * * * * * * *", { align: "center" }),
  gap(),
  p("DEPOSITION OF {{steve|STEPHEN MICHAEL SMITH}}", { align: "center", font: "b" }),
  p("(Taken to perpetuate testimony pursuant to Maryland Rule 4-261)", { align: "center" }),
  gap(),
  p("Baltimore, Maryland", { align: "center" }),
  p("Thursday, {{month|May 30, 2024}}", { align: "center" }),
  p("10:04 a.m.", { align: "center" }),
  gap(),
  p("Taken at: {{sao|Office of the State's Attorney for Baltimore City}}"),
  p("{{b_sao|120 E. Baltimore Street, Baltimore, MD 21202}}, 9th Floor"),
  gap(),
  p("Reported by: {{reporter|Denise Harmon}}, RPR, Notary Public"),
  p("{{harmon_cr|Harmon Court Reporting, LLC}}"),
  pageBreak(),
  p("APPEARANCES", { align: "center", font: "b" }),
  gap(),
  p("On behalf of the State of Maryland:", { font: "b" }),
  p("{{asa|MARCUS WHITFIELD}}, ESQUIRE", { left: 36 }),
  p("Assistant State's Attorney", { left: 36 }),
  p("{{sao|Office of the State's Attorney for Baltimore City}}", { left: 36 }),
  p("{{b_sao|120 E. Baltimore Street, Baltimore, MD 21202}}", { left: 36 }),
  p("{{num:phone|(410) 555-0142}}", { left: 36 }),
  gap(),
  p("On behalf of the Defendant:", { font: "b" }),
  p("{{okafor|LAUREN OKAFOR}}, ESQUIRE", { left: 36 }),
  p("{{firm|Okafor & Reyes LLP}}", { left: 36 }),
  p("{{b_firm|201 N. Charles Street, Suite 1400, Baltimore, MD 21201}}", { left: 36 }),
  p("{{num:phone|(410) 555-0177}}", { left: 36 }),
  gap(),
  p("Also present:", { font: "b" }),
  p("{{john|John A. Smith}}, Defendant", { left: 36 }),
  p("{{det|Detective Brian Kowalski}}, {{bpd|Baltimore Police Department}}", { left: 36 }),
  gap(),
  p("Court Reporter:", { font: "b" }),
  p("{{reporter|Denise Harmon}}, RPR, {{harmon_cr|Harmon Court Reporting, LLC}}", { left: 36 }),
  pageBreak(),
  p("I N D E X", { align: "center", font: "b" }),
  gap(),
  p("WITNESS: {{steve|STEPHEN MICHAEL SMITH}}", { font: "b" }),
  gap(),
  table({ cols: [{ x: 0 }, { x: 330 }], rows: [["EXAMINATION", "PAGE"]], size: 11 }),
  table({ cols: [{ x: 18 }, { x: 330 }], rows: [["By {{asa|Mr. Whitfield}} (direct)", "@@IDX_DIRECT@@"]], size: 11 }),
  table({ cols: [{ x: 18 }, { x: 330 }], rows: [["By {{okafor|Ms. Okafor}} (cross)", "@@IDX_CROSS@@"]], size: 11 }),
  table({ cols: [{ x: 18 }, { x: 330 }], rows: [["By {{asa|Mr. Whitfield}} (redirect)", "@@IDX_REDIRECT@@"]], size: 11 }),
  gap(),
  table({ cols: [{ x: 0 }, { x: 330 }], rows: [["EXHIBITS", "MARKED"]], size: 11 }),
  table({ cols: [{ x: 18 }, { x: 330 }], rows: [["State's 1 - Door-access log ({{num:bates|ACME-000212}})", "@@IDX_EX1@@"]], size: 11 }),
  table({ cols: [{ x: 18 }, { x: 330 }], rows: [["State's 2 - Photograph, silver Ford F-150", "@@IDX_EX2@@"]], size: 11 }),
  table({ cols: [{ x: 18 }, { x: 330 }], rows: [["State's 3 - Account-opening file ({{num:bates|CFB-000003}})", "@@IDX_EX3@@"]], size: 11 }),
  gap(),
  p("(Original exhibits retained by the {{sao|Office of the State's Attorney}}.)"),
  pageBreak(),
  p("PROCEEDINGS", { align: "center", font: "b" }),
  gap(),
  SAY(
    "THE REPORTER",
    "We are on the record at 10:04 a.m. on {{month|May 30, 2024}}. {{modal|Will}} counsel please state their appearances for the record?",
  ),
  SAY(WIT, "{{asa|Marcus Whitfield}} for the State."),
  SAY(OKA, "{{okafor|Lauren Okafor}} for the defendant, {{john|John Smith}}, who is present."),
  NOTE("The witness was sworn by the reporter."),
  p(`{{steve|STEPHEN MICHAEL SMITH}}, having been first duly sworn, testified as follows:`, { indent: 36 }),
  p("DIRECT EXAMINATION", { align: "center", font: "b" }),
  p(`BY ${WIT}:`, { marker: "IDX_DIRECT" }),
  Q("Good morning. Please state your full name for the record."),
  A("{{steve|Stephen Michael Smith}}."),
  Q("And your current address?"),
  A("{{addr_steve|3306 Linden Court, Apartment 2B, Towson, Maryland 21204}}. Until the end of June, anyway."),
  Q("Where are you moving at the end of June?"),
  A("Stuttgart, Germany. My company is sending me over for two years."),
  Q(
    "That's why we're here today, to preserve your testimony in case you're not available for trial. Do you understand that?",
  ),
  A("I do."),
  Q(
    "{{steve|Mr. Smith}}, I'm going to ask you a series of questions. If you don't understand one, tell me and I will rephrase it. Fair?",
  ),
  A("Fair."),
  Q("You're the son of the defendant, {{john|John Smith}}?"),
  A("Yes. He's my father."),
  Q("And your mother is {{mary|Mary Smith}}?"),
  A("{{mary|Mary Elizabeth Smith}}, yes."),
  Q("Where do your parents live?"),
  A("{{addr_smith|1418 Elm Street}}, in Baltimore. I grew up in that house."),
  Q("Did you live there in {{month|May of 2024}}?"),
  A(
    "No. I moved out years ago. But I'm over there a lot, because my daughter stays with my parents when I'm traveling for work.",
  ),
  Q("What is your daughter's name?"),
  A("{{emily|Emily}}. {{emily|Emily Rose}}."),
  SAY(
    OKA,
    "Objection, and a request. She's seven years old. I'd ask that for the rest of the transcript we refer to her by her initials, {{emily|E.S.}}",
  ),
  SAY(WIT, "No objection. We'll use {{emily|E.S.}}"),
  SAY("THE WITNESS", "Sorry. I didn't know."),
  SAY(OKA, "It's fine, {{steve|Mr. Smith}}. You didn't do anything wrong."),
];

DEPO.push(
  p(`BY ${WIT}:`),
  Q("Who has custody of {{emily|E.S.}}?"),
  A(
    "Her mom and I share it. Her mom is {{kara|Kara Delaney}}. We were never married. {{emily|E.S.}} is with {{kara|Kara}} during the school week and with me on weekends, except when I travel.",
  ),
  Q("And when you travel, she stays at {{addr_smith|the Elm Street house}}?"),
  A("Usually, yes. My mom picks her up from school."),
  Q("Was {{emily|E.S.}} staying with your parents during the first week of {{month|May 2024}}?"),
  A("Yes. I was in Cleveland Monday through Thursday. I got back Friday afternoon."),
  Q("Friday being {{month|May 3rd}}?"),
  A("Yes."),
  Q("Let's talk about your work history. Have you ever been employed by {{acme|Acme Logistics}}?"),
  A("Yes. In 2022, for about seven months. I was a temp loader on the night shift, then they hired me on."),
  Q("At which facility?"),
  A("The warehouse on Holabird Avenue. The same one my dad runs. Ran."),
  Q("How did you get that job?"),
  A("My dad told me they needed people. I was between jobs."),
  Q("Who was your supervisor there?"),
  A(
    "{{will|Will Marsh}} trained me. {{will|Will}} was the shift supervisor on nights. Above him was my dad, but my dad worked days.",
  ),
  Q("When you say {{will|Will}}, you mean {{will|William Marsh}}?"),
  A("Yes. Everybody calls him {{will|Will}}."),
  Q("How did you get along with {{will|Mr. Marsh}}?"),
  A("Fine. He's a by-the-book guy. He will tell you if you parked a forklift crooked."),
  Q("How did your father get along with {{will|Mr. Marsh}}?"),
  SAY(OKA, "Objection. Foundation."),
  Q("If you know."),
  A(
    "They were fine until the promotion thing. {{will|Will}} wanted the operations job and they gave it to my dad instead, back in 2019. After that {{will|Will}} was kind of cold to him.",
  ),
  Q("Did your father ever talk to you about {{will|Mr. Marsh}}?"),
  A(
    "Sometimes. He'd say {{will|Will}} was gunning for him. I figured that was just work stuff. Everybody at the warehouse calls my dad {{john|Johnny}}, and {{will|Will}} was the only one who called him {{john|John}}.",
  ),
  Q("Why did you leave {{acme|Acme}}?"),
  A("I got the job I have now, doing logistics software. Better hours."),
  Q("When you left, did you turn in your access badge?"),
  A("Yes. They deactivated it. I remember because I had to sign a form."),
  Q("While you worked at {{acme|Acme}}, did you learn where the operations office was?"),
  A("Sure. Second floor, up the back stairs from the dock. Everybody knows where it is."),
  Q("And the rear dock door, Door D-4?"),
  A("I don't know the numbers. There's a back door by the trash compactor that the night crew uses."),
  Q("Did you know a security guard named {{price|Darnell Price}}?"),
  A(
    "A little. {{price|Darnell}} was one of the guards when I worked there. Nice guy. I heard he got hurt. I'm sorry about that.",
  ),
  Q("How did you hear that {{price|Mr. Price}} had been hurt?"),
  A("My dad told me. The Monday after, I think. He said the police wanted to talk to him."),
  Q("I want to turn to Friday, {{month|May 3, 2024}}. Where were you that evening?"),
  A("At my parents' house. I drove over after work to have dinner and see {{emily|E.S.}}"),
  Q("What time did you arrive?"),
  A("Around six-thirty."),
  Q("Who was at the house?"),
  A("My mom, my dad, {{emily|E.S.}}, and me."),
  Q("How did you get there?"),
  A("I drove my own car. A blue Civic."),
  Q("Where did you park?"),
  A("On the street, in front of {{may|Mrs. Chen's}} house. My dad's truck was in the driveway and my mom's Honda was behind it."),
  Q("Who is {{may|Mrs. Chen}}?"),
  A("{{may|May Chen}}. She lives next door, at {{addr_chen|1420 Elm}}. She's lived there since I was a kid."),
  Q("Describe your father's truck."),
  A("Silver Ford F-150. A 2019, I think."),
  SAY(WIT, "I'm going to have this marked as State's Exhibit 2."),
  { ...NOTE("State's Exhibit No. 2 was marked for identification."), marker: "IDX_EX2" },
  Q("Showing you what's been marked State's Exhibit 2. Do you recognize it?"),
  A("That's my dad's truck. That's the driveway at {{addr_smith|Elm}}."),
  Q("What happened after dinner?"),
  A(
    "We ate around seven. My mom went upstairs early, she'd been feeling run down. Around nine-thirty {{emily|E.S.}} said her ear hurt and she felt hot. My dad took her temperature and it was a hundred and three.",
  ),
  Q("What did your father do?"),
  A(
    "He said he was taking her to the urgent care on Conkling Street, the {{clinic|Harbor Pediatric}} place. He's the one who usually handles that stuff. He took my mom's Honda because that's where the car seat is.",
  ),
  Q("What time did he leave?"),
  A("Maybe quarter to ten. A little before."),
  Q("Did you go with them?"),
  A("No. I stayed at the house in case my mom needed anything."),
  Q("Did you stay at the house the whole time your father was gone?"),
  A("No."),
  Q("Where did you go?"),
  A(
    "I took my dad's truck out for a while. I'd had an argument on the phone with {{kara|Kara}} and I needed to drive around and clear my head.",
  ),
  Q("Why did you take your father's truck rather than your own car?"),
  A(
    "My car was blocked in on the street by a delivery van, and the truck keys were right there on the hook. I've driven that truck a hundred times.",
  ),
);

DEPO.push(
  Q("What time did you leave in the truck?"),
  A("Right around ten. Maybe five after."),
  Q("Where did you go?"),
  A(
    "I drove up Harford Road to a gas station and got a coffee. Then I just drove. Loch Raven, around the reservoir. I wasn't paying attention to the time.",
  ),
  Q("Did you drive to the {{acme|Acme}} warehouse on Holabird Avenue?"),
  A("No."),
  Q("Did you drive anywhere near Holabird Avenue?"),
  A("No. That's the opposite direction. I was north the whole time."),
  Q("Do you have a receipt from the gas station?"),
  A("I paid cash. I didn't keep it."),
  Q("Did anyone see you while you were driving around?"),
  A("The guy at the gas station, I guess. I don't know his name."),
  Q("What were you wearing that night?"),
  A("Jeans, a dark Carhartt jacket, boots. Probably my Orioles hat."),
  Q("Do you wear an Orioles cap often?"),
  A("Most days. So does my dad. So does half of Baltimore."),
  Q("What time did you return to {{addr_smith|1418 Elm Street}}?"),
  A("Around quarter to twelve. My dad and {{emily|E.S.}} were already home. The Honda was back in the driveway."),
  Q("Where did you park the truck?"),
  A("In the driveway, where it was. Then I went in the side door."),
  Q("Did you see anyone outside when you came back?"),
  A(
    "I think {{may|Mrs. Chen's}} porch light was on. I didn't see her. If she says she saw {{john|Mr. Smith}} get out of the truck, I mean, that was probably me. We're built about the same.",
  ),
  Q("How tall are you?"),
  A("Five eleven. About two-forty."),
  Q("And your father?"),
  A("Five ten, maybe. Heavier than he should be. He'd tell you the same thing."),
  Q("When you took the truck keys off the hook, what else was on that hook?"),
  A("My mom's keys, and my dad's work lanyard."),
  Q("The lanyard with his {{acme|Acme}} badge?"),
  A("Yes. He hangs it there when he comes home."),
  Q("Was the lanyard on the hook when you left at ten?"),
  A("I think so. I'm not a hundred percent."),
  Q("Was it on the hook when you came back?"),
  A("I didn't look. I didn't have any reason to look."),
  Q("Did you take your father's badge that night?"),
  A("No."),
  Q("Did you ever use your father's badge, at any time?"),
  A("No. Never."),
  SAY(WIT, "Let's mark this as State's 1."),
  { ...NOTE("State's Exhibit No. 1 was marked for identification."), marker: "IDX_EX1" },
  Q(
    "This is a door-access log produced by {{acme|Acme}}, Bates number {{num:bates|ACME-000212}}. It shows badge {{num:badge|A-20417}} used at Door D-4 at 10:37 p.m. on {{month|May 3}}. Do you see that?",
  ),
  A("I see it."),
  Q("Do you know whose badge number that is?"),
  A("I assume it's my dad's. I don't know his number."),
  Q("At 10:37 p.m. on {{month|May 3}}, where was your father?"),
  SAY(OKA, "Objection. Calls for speculation. He's testified he wasn't with his father."),
  Q("You can answer if you know."),
  A("He was at the urgent care with {{emily|E.S.}} That's what he told me, and that's when they were gone."),
  Q("Did your father ever talk to you about a company called {{patapsco|Patapsco Freight Services}}?"),
  A("No. I'd never heard of it until the detective called."),
  Q("Do you know whether your parents bank at {{cfb|Chesapeake Federal Bank}}?"),
  A("They do. The branch on Eastern Avenue. They've had accounts there forever."),
  Q("Have you ever been inside that branch?"),
  A("A couple times with my mom, when I was younger. Not recently."),
  Q("Do you know a teller there named {{rosa|Rosa Delgado}}?"),
  A("No."),
  SAY(WIT, "State's 3."),
  { ...NOTE("State's Exhibit No. 3 was marked for identification."), marker: "IDX_EX3" },
  Q(
    "State's 3 is an account-opening file from {{cfb|Chesapeake Federal}}, Bates {{num:bates|CFB-000003}} through {{num:bates|CFB-000009}}. On the third page there's a signature over the name {{john|John A. Smith}}. Do you recognize that signature?",
  ),
  A("It looks like his. Kind of. My dad's J is bigger, usually. I couldn't swear to it."),
  Q("The application lists a Social Security number of {{ssn_john|212-48-6789}}. Is that your father's number?"),
  SAY(
    OKA,
    "Objection. And I'd ask the reporter to note that the parties will file a redacted version of this transcript. Full Social Security numbers shouldn't be in a public filing.",
  ),
  SAY(WIT, "Agreed. We'll redact for the public file."),
  Q("{{steve|Mr. Smith}}, do you know your father's Social Security number?"),
  A("No. I know the last four is {{ssn_john|6789}}, because he uses it as a PIN for everything. He'll kill me for saying that."),
  Q("Does anyone else in your family know his full number?"),
  A("My mom, I'm sure. She does all the taxes."),
  Q("For completeness, what is your own Social Security number?"),
  SAY(OKA, "Objection. Relevance."),
  SAY(WIT, "It goes to the bank records, counsel. There's a second application in the file."),
  SAY(OKA, "Then show him the document. I'll let him answer, subject to the redaction agreement."),
  A("{{ssn_steve|219-63-4102}}."),
  Q("Have you ever opened a bank account at {{cfb|Chesapeake Federal}} using your father's information?"),
  A("No. Absolutely not."),
  Q("Have you ever opened any account in the name of {{patapsco|Patapsco Freight}}?"),
  A("No."),
  Q("Did your father ever ask you to make cash withdrawals for him?"),
  A("No."),
  Q("Did your mother?"),
  A("No. My mom doesn't even use the ATM."),
  Q("After {{month|May 3}}, did you discuss that night with your father?"),
  A("Yes. He asked if I'd taken the truck. I said yes. He said the police might want to talk to me."),
  Q("Did he ask you to say anything in particular?"),
  A("He said to tell the truth. That's it."),
  Q("Did you talk to {{may|May Chen}} after that night?"),
  A(
    "I waved to her once when I picked {{emily|E.S.}} up. She looked at me kind of funny. We didn't talk about it.",
  ),
  SAY(WIT, "I don't have anything further at this time. I'll reserve the balance for redirect."),
  SAY(OKA, "Can we take five minutes?"),
  SAY(WIT, "Sure."),
  NOTE("A recess was taken from 11:02 a.m. to 11:10 a.m."),
);

DEPO.push(
  p("CROSS-EXAMINATION", { align: "center", font: "b" }),
  p(`BY ${OKA}:`, { marker: "IDX_CROSS" }),
  Q(
    "{{steve|Mr. Smith}}, my name is {{okafor|Lauren Okafor}}. I represent your father. I'm going to refer to him as your father or as {{john|Mr. Smith}} senior so the record is clear. Okay?",
  ),
  A("Okay."),
  Q("You told {{asa|Mr. Whitfield}} you left the house in the truck at about ten o'clock. How do you know the time?"),
  A("Because I was on the phone with {{kara|Kara}} and I looked at the call when I hung up. It was right before ten."),
  Q("If I told you that the phone records show your call with {{kara|Ms. Delaney}} ended at 9:58 p.m., would that be consistent?"),
  A("Yes."),
  Q("So you got in the truck within a few minutes after 9:58?"),
  A("Yes."),
  Q("And your father had already left with {{emily|E.S.}} in the Honda?"),
  A("Yes. Ten, fifteen minutes before that."),
  Q("You didn't see your father again until you came home around 11:45?"),
  A("Right."),
  Q("So from about 9:45 until 11:45, you don't personally know where your father was?"),
  A("Not personally. He was at the urgent care."),
  Q("That's what he told you?"),
  A("Yes. And {{emily|E.S.}} had a bandage on her arm from where they did a blood test, and she had a bottle of the pink medicine."),
  Q("Let's talk about the drive. You were gone from about ten to about 11:45. That's an hour and forty-five minutes?"),
  A("About that."),
  Q("And the only stop you can tell us about is a gas station on Harford Road?"),
  A("Yes."),
  Q("You told the detective on {{month|May 7}} that you would give a statement only with a lawyer present. Do you remember that?"),
  A("Yes. My dad's lawyer, you, told me that was smart."),
  SAY(OKA, "For the record, I don't represent the witness, and I advised him to consult his own counsel."),
  SAY("THE WITNESS", "That's right. Sorry."),
  Q("Did you consult a lawyer?"),
  A("I talked to one on the phone. I decided I didn't need one. I didn't do anything."),
  Q("{{steve|Mr. Smith}}, you worked nights at the Holabird warehouse for seven months?"),
  A("Yes."),
  Q("So you know that the night crew leaves by six on Fridays?"),
  A("They did when I was there. Friday nights were dead."),
  Q("And you know there's one guard on Friday nights?"),
  A("I knew that back then. I don't know what they do now."),
  Q("You knew {{price|Mr. Price}} was one of the guards?"),
  A("Yes, but I haven't seen {{price|Darnell}} in two years."),
  Q("You knew the back stairs led from the dock to the operations office?"),
  A("Yes. I said that."),
  Q("And you know your father keeps his badge on that lanyard, on the hook by the kitchen door?"),
  A("Everybody in the family knows that."),
  Q("Your own {{acme|Acme}} badge was deactivated when you left in 2022?"),
  A("Yes."),
  Q("So if you wanted to get into that warehouse in 2024, you would need someone else's badge?"),
  SAY(WIT, "Objection. Argumentative."),
  SAY(OKA, "I'll rephrase."),
  Q("Your own badge would not have opened Door D-4 in {{month|May 2024}}, correct?"),
  A("Correct. But I didn't try to open anything."),
  Q("You told us you own an Orioles cap. Were you wearing it that night?"),
  A("I said probably. I'm usually wearing it."),
  Q("And you're five eleven, about two-forty?"),
  A("Yes."),
  Q("{{price|Mr. Price}} described the man in the office as heavyset, around five ten, in a dark cap and a dark jacket. You were wearing a dark jacket?"),
  SAY(WIT, "Objection. Counsel is testifying about a description that's not in evidence in this deposition."),
  SAY(OKA, "It's in the police report the State produced."),
  A("I was wearing a dark jacket. So was everybody. It was cold."),
  SAY(OKA, "{{modal|May}} I approach the witness?"),
  SAY(WIT, "Go ahead."),
  Q(
    "I'm showing you page four of State's 3, the signature card for the {{patapsco|Patapsco}} account. It lists a joint signer, {{mary|Mary E. Smith}}, Social Security number {{ssn_mary|***-**-4417}}. Do you know whether {{ssn_mary|4417}} are the last four digits of your mother's number?",
  ),
  A("I don't know my mom's number. I really don't."),
  Q("Would your mother have signed anything to open a business account?"),
  SAY(WIT, "Objection. Speculation."),
  A("I don't think she'd sign anything my dad didn't read to her first. She doesn't do business stuff."),
  Q("Let's talk about {{will|Mr. Marsh}}. You said {{will|Will Marsh}} wanted your father's job?"),
  A("That's what my dad said. And {{will|Will}} said it himself once at a cookout. He'd had a few beers."),
  Q("What did {{will|Mr. Marsh}} say?"),
  A(
    "Something like, 'One of these days {{john|Johnny}} will slip up and I'll be right there.' Everybody laughed. I didn't think it was funny.",
  ),
  Q("When was that cookout?"),
  A("Summer of 2022. At the warehouse. The company does one every July."),
  Q("Did you ever see {{will|Mr. Marsh}} near your father's office after hours?"),
  A("I mean, he worked nights. He was everywhere after hours. That was his job."),
  Q("{{modal|Will}} you agree that {{will|Mr. Marsh}} had keys and a badge to that office?"),
  SAY(WIT, "Objection. Foundation."),
  A("He had to. He was the night supervisor. Unless they changed it."),
  Q("Turning to {{may|Ms. Chen}}. You've known {{may|May Chen}} most of your life?"),
  A("Since I was eight or nine. She used to babysit me sometimes."),
  Q("Does {{may|Ms. Chen}} have any trouble with her eyesight, to your knowledge?"),
  A("She wears glasses. Thick ones. I don't know about at night."),
  Q("When you came home at 11:45, did you walk from the truck to the side door?"),
  A("Yes."),
  Q("The same route {{may|Ms. Chen}} described someone she called {{john|Mr. Smith}} taking?"),
  SAY(WIT, "Objection. Mischaracterizes. The witness hasn't seen her statement."),
  Q("Let me ask it this way. Is there any other way into the house from the driveway, other than the side door?"),
  A("No. The front door's on the other side, on {{addr_smith|Elm Street}}."),
  Q("And when you got out of the truck, you were wearing the cap and the dark jacket?"),
  A("Probably. Yes."),
  Q("{{steve|Mr. Smith}}, did you enter the {{acme|Acme}} warehouse on the night of {{month|May 3, 2024}}?"),
  A("No. I swear I didn't."),
  Q("Did you push {{price|Darnell Price}} down the stairs?"),
  A("No. I would never hurt {{price|Darnell}}."),
  SAY(OKA, "Nothing further."),
);

DEPO.push(
  p("REDIRECT EXAMINATION", { align: "center", font: "b" }),
  p(`BY ${WIT}:`, { marker: "IDX_REDIRECT" }),
  Q("{{steve|Mr. Smith}}, just a few more. You said you were on the phone with {{kara|Ms. Delaney}} until about 9:58?"),
  A("Yes."),
  Q("Was {{emily|E.S.}} still at the house when you started that call?"),
  A("She was in the living room with my dad, lying on the couch. He was getting her shoes on."),
  Q("So you saw your father and {{emily|E.S.}} leave the house together?"),
  A("I saw them go out the side door. I heard the Honda start."),
  Q("You didn't see which direction the Honda went?"),
  A("No. I was on the phone."),
  Q("When you came home, did your father say anything about the urgent care?"),
  A("He said they gave her antibiotics and it was an ear infection. He said the waiting room was packed."),
  Q("Did he say what time they were seen by a doctor?"),
  A("No. Just that it took forever."),
  Q("Did your father seem out of breath, or hurt, or upset?"),
  A("He seemed tired. It was midnight. He's sixty-one."),
  Q("Was he wearing an Orioles cap?"),
  A("I don't remember. I really don't."),
  Q("Last question. When the {{bpd|Baltimore Police Department}} detective called you on {{month|May 7}}, did you tell him you had taken the truck?"),
  A(
    "Not on that call. I said I'd talk with a lawyer. I told my dad's lawyer later. And I'm telling you now.",
  ),
  SAY(WIT, "Thank you, {{steve|Mr. Smith}}. Nothing further."),
  SAY(OKA, "Nothing further from the defense."),
  SAY(
    "THE REPORTER",
    "{{modal|Will}} the witness read and sign?",
  ),
  SAY(OKA, "He'll read and sign. Please send the transcript to my office and I'll forward it."),
  SAY(WIT, "And for the record, the State's copy should be the redacted version, with the minor identified as {{emily|E.S.}} only."),
  NOTE("Whereupon, at 11:58 a.m., the deposition was concluded. Signature reserved."),
  pageBreak(),
  p("ACKNOWLEDGMENT OF DEPONENT", { align: "center", font: "b" }),
  gap(),
  p(
    "I, {{steve|Stephen Michael Smith}}, do hereby certify that I have read the foregoing transcript of my testimony taken on {{month|May 30, 2024}}, and that it is a true and accurate record of my testimony, with the exception of any corrections noted on the errata sheet below.",
  ),
  gap(),
  table({ cols: [{ x: 0 }, { x: 60 }, { x: 120 }], head: ["PAGE", "LINE", "CORRECTION AND REASON"], rows: [["", "", ""]], size: 10 }),
  rule(),
  rule(),
  rule(),
  rule(),
  gap(),
  p("______________________________"),
  p("{{steve|STEPHEN MICHAEL SMITH}}"),
  gap(),
  p("Subscribed and sworn before me this ____ day of __________, 2024."),
  gap(),
  p("______________________________ Notary Public"),
  pageBreak(),
  p("CERTIFICATE OF COURT REPORTER", { align: "center", font: "b" }),
  gap(),
  p(
    "I, {{reporter|Denise Harmon}}, Registered Professional Reporter and Notary Public in and for the State of Maryland, do hereby certify that the witness, {{steve|STEPHEN MICHAEL SMITH}}, was duly sworn by me; that the foregoing is a true and accurate transcript of the testimony given, reduced to typewriting under my supervision; and that I am neither counsel for, related to, nor employed by any of the parties to this action.",
    { indent: 36 },
  ),
  gap(),
  p(
    "Pursuant to the agreement of counsel on the record, the public-filing version of this transcript shall redact Social Security numbers and identify the minor child by initials only.",
    { indent: 36 },
  ),
  gap(),
  p("WITNESS my hand and notarial seal this 4th day of June, 2024."),
  gap(),
  p("/s/ {{reporter|Denise Harmon}}"),
  p("{{reporter|Denise Harmon}}, RPR, Notary Public"),
  p("My commission expires: 11/30/2027"),
  p("{{harmon_cr|Harmon Court Reporting, LLC}} -- {{num:phone|(410) 555-0199}}"),
);

DOCS.push({
  file: "03-deposition-steve-smith.pdf",
  title: "Deposition Transcript",
  size: 11,
  leading: 1,
  numbered: true,
  header: (n) => [{ left: "Deposition of {{steve|Stephen M. Smith}}", right: `{{month|May 30, 2024}} -- Page ${n}` }],
  footer: (n, t) => [{ left: "{{harmon_cr|Harmon Court Reporting, LLC}}", right: `Page ${n} of ${t}` }],
  blocks: DEPO,
});

// ---------------------------------------------------------------------------
// 04 Bank subpoena response (SSN last-4 / masked; routing, account, CIF decoys)
// ---------------------------------------------------------------------------
const cfbTx = (d: string, desc: string, debit: string, credit: string, bal: string) => [d, desc, debit, credit, bal];
DOCS.push({
  file: "04-bank-subpoena-response.pdf",
  title: "Bank Subpoena Response",
  size: 10,
  leading: 1.45,
  header: (n) =>
    n === 1
      ? [{ left: "{{cfb|CHESAPEAKE FEDERAL BANK}}", right: "Legal Process Department" }, { left: "{{b_cfb|25 S. Charles Street, Suite 900, Baltimore, MD 21201-3456}}", right: "Tel. {{num:phone|(410) 555-0110}}" }]
      : [{ left: "{{cfb|Chesapeake Federal Bank}} -- Subpoena Response", right: "Our Ref. {{num:reference|LP-2024-11873}}" }],
  footer: (n, t) => [
    { left: "CONFIDENTIAL -- PRODUCED PURSUANT TO SUBPOENA", right: `{{num:bates|CFB-00000${n}}}` },
    { center: `Page ${n} of ${t}` },
  ],
  blocks: [
    p("{{month|May 17, 2024}}", { before: 0 }),
    p("VIA SECURE ELECTRONIC DELIVERY", { font: "b", size: 9 }),
    p("{{asa|Marcus Whitfield}}, Assistant State's Attorney", { before: 8 }),
    p("{{sao|Office of the State's Attorney for Baltimore City}}", { before: 0 }),
    p("{{b_sao|120 E. Baltimore Street, Baltimore, MD 21202}}", { before: 0 }),
    p(
      `Re: Subpoena Duces Tecum dated {{month|May 10, 2024}} -- State of Maryland v. {{john|John A. Smith}}, Case No. ${CASE_NO}`,
      { font: "b", before: 10, left: 0 },
    ),
    p(`Dear {{asa|Mr. Whitfield}}:`, { before: 10 }),
    p(
      `{{cfb|Chesapeake Federal Bank}} (the "Bank") responds to the above-referenced subpoena, which requested records for any deposit
      account titled to {{patapsco|Patapsco Freight Services}} or on which the subject, {{john|John A. Smith}}, is an owner or authorized
      signer, for the period December 1, 2023 through {{month|May 10, 2024}}. The Bank has identified one responsive account,
      summarized below. Account-opening documents and signature cards are produced separately as {{num:bates|CFB-000003}} through
      {{num:bates|CFB-000009}}. Statements are produced as {{num:bates|CFB-000010}} through {{num:bates|CFB-000021}}.`,
    ),
    kv(
      [
        ["Account Title:", "{{patapsco|Patapsco Freight Services}} (sole proprietorship, DBA)"],
        ["Account Type / No.:", "Business Essentials Checking / {{num:account|0047-2219-5510}}"],
        ["ABA Routing No.:", "{{num:routing|052000113}}"],
        ["Date Opened / Branch:", "12/18/2023 -- Highlandtown, {{b_branch|3400 Eastern Avenue, Baltimore, MD 21224}}"],
        ["Primary Owner:", "{{john|John A. Smith}} -- TIN on file: {{ssn_john|XXX-XX-6789}} (SSN; no EIN provided)"],
        ["Customer ID (CIF):", "{{num:cif|307-41-8826}}"],
        ["Address of Record:", "{{addr_smith|1418 Elm Street, Baltimore, MD 21218}}"],
        ["Authorized Signer:", "{{mary|Mary E. Smith}} -- SSN {{ssn_mary|***-**-4417}} (added 12/18/2023)"],
        ["Online Banking:", "Not enrolled. Debit card not issued."],
        ["Status:", "Open; restricted 05/13/2024 at law-enforcement request"],
      ],
      { labelW: 140, before: 8 },
    ),
    p(
      `Identity verification at account opening was performed in person by the branch platform officer using a Maryland driver's
      license in the name of {{john|John Andrew Smith}} and a Social Security number whose last four digits are {{ssn_john|6789}}.
      The Bank's records reflect that the identification was scanned, but the image retained in the file (see {{num:bates|CFB-000005}})
      is of poor quality. The Bank makes no representation as to the identity of the individual who appeared.`,
      { before: 8 },
    ),
    p(
      `Deposits to the account consist of fourteen ACH credits originated by {{acme|Acme Logistics LLC}} (originator EIN
      {{num:ein|52-1234567}}) totaling $63,450.00. Withdrawals consist of eleven in-branch cash withdrawals totaling $58,900.00, each
      processed at the Highlandtown branch, ten of them by teller station {{num:teller_id|0417}}, which was assigned during the period
      to teller {{rosa|Rosa Delgado}}. Withdrawal tickets are signed "{{john|J. Smith}}." Copies are available on request.`,
    ),
    p(
      `This response is made by the Bank's Legal Process Department as custodian of records. A certification under Maryland Rule
      5-902(b) is enclosed. Please direct any questions to the Legal Process Department at the number above, referencing our file
      number {{num:reference|LP-2024-11873}}.`,
    ),
    p("Sincerely,", { before: 10 }),
    p("Legal Process Department, {{cfb|Chesapeake Federal Bank}}", { before: 2 }),
    pageBreak(),
    sh("ACCOUNT ACTIVITY SUMMARY -- {{num:account|0047-2219-5510}}", { before: 0 }),
    p(
      `Account holder: {{patapsco|PATAPSCO FREIGHT SERVICES}}, {{john|JOHN A SMITH}} PROP -- Statement address
      {{addr_smith|1418 ELM ST, BALTIMORE MD 21218}}`,
      { size: 9 },
    ),
    table({
      cols: [{ x: 0 }, { x: 58 }, { x: 290, align: "right" }, { x: 350, align: "right" }, { x: 410, align: "right" }],
      head: ["Date", "Description", "Debit", "Credit", "Balance"],
      size: 8.5,
      rows: [
        cfbTx("12/18/23", "OPENING DEPOSIT - CASH", "", "100.00", "100.00"),
        cfbTx("01/12/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-00217}}", "", "4,350.00", "4,450.00"),
        cfbTx("01/26/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-00388}}", "", "4,875.00", "9,325.00"),
        cfbTx("01/30/24", "CASH W/D TELLER {{num:teller_id|0417}} BR 0412", "8,000.00", "", "1,325.00"),
        cfbTx("02/09/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-01102}}", "", "3,900.00", "5,225.00"),
        cfbTx("02/23/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-01544}}", "", "5,200.00", "10,425.00"),
        cfbTx("02/27/24", "CASH W/D TELLER {{num:teller_id|0417}} BR 0412", "9,500.00", "", "925.00"),
        cfbTx("03/08/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-02090}}", "", "4,600.00", "5,525.00"),
        cfbTx("03/15/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-02311}}", "", "4,425.00", "9,950.00"),
        cfbTx("03/19/24", "CASH W/D TELLER {{num:teller_id|0417}} BR 0412", "9,000.00", "", "950.00"),
        cfbTx("03/29/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-02876}}", "", "4,950.00", "5,900.00"),
        cfbTx("04/05/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-03140}}", "", "4,100.00", "10,000.00"),
        cfbTx("04/09/24", "CASH W/D TELLER {{num:teller_id|0422}} BR 0412", "9,200.00", "", "800.00"),
        cfbTx("04/19/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-03702}}", "", "4,725.00", "5,525.00"),
        cfbTx("04/26/24", "ACH CR {{acme|ACME LOGISTICS LLC}} VNDR PMT {{num:invoice|INV-2024-05831}}", "", "4,575.00", "10,100.00"),
        cfbTx("04/30/24", "CASH W/D TELLER {{num:teller_id|0417}} BR 0412", "9,800.00", "", "300.00"),
        cfbTx("05/13/24", "ACCOUNT RESTRICTED - LEGAL HOLD", "", "", "300.00"),
      ],
    }),
    p(
      `Note: Activity above is a summary of the fourteen ACH credits and the largest cash withdrawals; six ACH credits and five smaller
      withdrawals ($600.00 to $3,100.00) appear on the full statements. No cash withdrawal exceeded $10,000.00 and no Currency
      Transaction Report was filed. Teller station {{num:teller_id|0422}} was staffed on 04/09/24 by a relief teller; all other
      withdrawals listed were processed by {{rosa|R. Delgado}}.`,
      { size: 9, before: 8 },
    ),
    sh("CERTIFICATION OF CUSTODIAN OF RECORDS (Md. Rule 5-902(b))"),
    p(
      `The undersigned, an authorized representative of the Legal Process Department of {{cfb|Chesapeake Federal Bank}}, certifies that
      the records produced herewith ({{num:bates|CFB-000001}} through {{num:bates|CFB-000021}}) were made at or near the time of the
      acts and events recorded, by or from information transmitted by persons with knowledge, in the course of regularly conducted
      business activity, and that it was the regular practice of the Bank to make such records.`,
      { size: 9.5 },
    ),
    p("Authorized Representative, Legal Process Department -- Date: 05/17/2024 -- Employee No. {{num:employee_id|CFB-77310}}", { size: 9.5, before: 10 }),
  ],
});

// ---------------------------------------------------------------------------
// 05 Employment records from Acme (undashed SSN in labeled field, W-2, memo)
// ---------------------------------------------------------------------------
DOCS.push({
  file: "05-employment-records-acme.pdf",
  title: "Employment Records",
  size: 10,
  leading: 1.45,
  header: () => [
    { left: "{{acme|ACME LOGISTICS LLC}} -- Human Resources", right: "CONFIDENTIAL PERSONNEL RECORD" },
    { left: "{{b_acme|2300 Smith Avenue, Baltimore, MD 21209}}", right: "Produced in response to subpoena" },
  ],
  footer: (n, t) => [{ left: `Page ${n} of ${t}`, right: `{{num:bates|ACME-00010${n}}}` }],
  blocks: [
    h("EMPLOYEE PERSONNEL DATA SHEET", { before: 0 }),
    rule(),
    kv([
      ["Employee Name:", "{{john|SMITH, JOHN A.}}"],
      ["Employee ID:", "{{num:employee_id|E-10442}}"],
      ["Social Security No.:", "{{ssn_john|212486789}}"],
      ["Date of Birth:", "{{num:dob|03/14/1963}}"],
      ["Home Address:", "{{addr_smith|1418 Elm Street, Baltimore, MD 21218}}"],
      ["Home Phone:", "{{num:phone|(410) 555-0173}}"],
      ["Hire Date:", "03/11/2002"],
      ["Position:", "Operations Manager, Holabird Distribution Center (since 08/2019)"],
      ["Work Location:", "{{b_warehouse|4900 Holabird Avenue, Baltimore, MD 21224}}"],
      ["Badge / Access Level:", "{{num:badge|A-20417}} / Level 3 (all doors incl. O-2 operations office)"],
      ["Invoice Approval Limit:", "$10,000 per invoice (suspended 05/01/2024)"],
      ["Status:", "Administrative leave without pay effective 05/07/2024"],
    ]),
    sh("EMERGENCY CONTACT / DEPENDENTS"),
    rule(),
    table({
      cols: [{ x: 0 }, { x: 150 }, { x: 230 }, { x: 330 }],
      head: ["Name", "Relationship", "SSN", "Phone / DOB"],
      size: 9,
      rows: [
        ["{{mary|Mary E. Smith}}", "Spouse", "{{ssn_mary|223-41-4417}}", "{{num:phone|(410) 555-0174}}"],
        ["{{emily|E.S.}} (minor)", "Grandchild*", "on file", "DOB {{num:dob|02/09/2017}}"],
      ],
    }),
    p(
      `*Grandchild added as a dependent for dental coverage only, 09/2023, under the guardianship-documentation exception. Supporting
      custody paperwork listing the child's parents, {{steve|Stephen M. Smith}} and {{kara|Kara Delaney}}, is on file with Benefits.`,
      { size: 8.5, before: 4 },
    ),
    sh("PAYROLL"),
    rule(),
    kv([
      ["Direct Deposit:", "{{cfb|Chesapeake Federal Bank}} -- Routing {{num:routing|052000113}} -- Acct. ending {{num:account|1186}}"],
      ["Pay Group / Rate:", "Salaried exempt -- $86,400.00 annual"],
      ["Federal / State W-4:", "Married filing jointly / MD exemptions 2"],
    ]),
    sh("PRIOR / RELATED PERSONNEL RECORD (cross-reference)"),
    rule(),
    kv([
      ["Related Employee:", "{{steve|SMITH, STEPHEN M.}} (son of employee)"],
      ["Employee ID:", "{{num:employee_id|E-21877}}"],
      ["SSN on file:", "{{ssn_steve|XXX-XX-4102}}"],
      ["Employment Dates:", "03/07/2022 (temp) -- 10/14/2022 (voluntary resignation)"],
      ["Badge:", "{{num:badge|A-31150}} -- deactivated 10/14/2022, physical badge returned"],
      ["Supervisor:", "{{will|W. Marsh}}, Night Shift Supervisor"],
    ]),
    pageBreak(),
    h("FORM W-2 WAGE AND TAX STATEMENT -- 2023 (Employer Copy D)", { before: 0 }),
    rule(),
    kv(
      [
        ["a  Employee's SSN:", "{{ssn_john|212-48-6789}}"],
        ["b  Employer EIN:", "{{num:ein|52-1234567}}"],
        ["c  Employer:", "{{acme|Acme Logistics LLC}}, {{b_acme|2300 Smith Avenue, Baltimore, MD 21209}}"],
        ["d  Control number:", "{{num:control|0010442-23}}"],
        ["e  Employee name:", "{{john|John A Smith}}"],
        ["f  Employee address:", "{{addr_smith|1418 Elm St, Baltimore MD 21218}}"],
        ["1  Wages, tips:", "$84,912.40"],
        ["2  Federal tax withheld:", "$9,844.18"],
        ["15 State / ID no.:", "MD / {{num:state_id|12-3456789}}"],
        ["16 State wages:", "$84,912.40"],
      ],
      { labelW: 160 },
    ),
    p(
      `Note: The Maryland withholding account number in Box 15 and the EIN in Box b are employer identifiers, not personal identifiers.
      Copies of W-2 forms for 2021 and 2022 were requested but are not included in this production.`,
      { size: 9, before: 6 },
    ),
    sh("BADGE ACCESS -- EMPLOYEE {{num:badge|A-20417}} -- 05/03/2024 (extract)"),
    rule(),
    table({
      cols: [{ x: 0 }, { x: 80 }, { x: 170 }, { x: 290 }],
      head: ["Time", "Door", "Result", "Credential"],
      size: 9,
      rows: [
        ["07:02:15", "Main Lobby L-1", "Granted", "{{num:badge|A-20417}}"],
        ["07:03:40", "Ops Office O-2", "Granted", "{{num:badge|A-20417}}"],
        ["16:48:09", "Main Lobby L-1 (exit)", "Granted", "{{num:badge|A-20417}}"],
        ["22:37:52", "Rear Dock D-4", "Granted", "{{num:badge|A-20417}}"],
        ["22:38:41", "Ops Office O-2", "Granted", "{{num:badge|A-20417}}"],
        ["23:19:30", "Rear Dock D-4", "Granted", "{{num:badge|A-17702}} ({{will|MARSH, W.}})"],
      ],
    }),
    p(
      `The access-control system records the credential presented, not the person presenting it. Door D-4 has no camera; the camera
      covering the dock apron (CAM-07) was out of service from {{month|May 1}} through {{month|May 6, 2024}} per work order
      {{num:work_order|WO-24-0613}}.`,
      { size: 9, before: 6 },
    ),
    pageBreak(),
    h("INTERNAL MEMORANDUM", { before: 0 }),
    kv([
      ["TO:", "Personnel File -- {{john|J. Smith}} ({{num:employee_id|E-10442}}); Compliance File {{num:reference|C-2024-019}}"],
      ["FROM:", "{{pruitt|Linda Pruitt}}, Director, Human Resources & Compliance"],
      ["DATE:", "April 30, 2024 (supplemented {{month|May 7, 2024}})"],
      ["RE:", "Report of {{will|William Marsh}} concerning {{patapsco|Patapsco Freight Services}} invoices"],
    ]),
    rule(),
    p(
      `On April 29, 2024, Night Shift Supervisor {{will|William Marsh}} met with me to report concerns about invoices from
      {{patapsco|Patapsco Freight Services}} approved by Operations Manager {{john|John Smith}}. {{will|Mr. Marsh}} stated that he
      had been asked by a carrier dispatcher why Acme was paying a drayage company "nobody has ever seen," and that when he checked the
      yard logs for the dates on the invoices he could not find a single {{patapsco|Patapsco}} trailer. He stated that the per-trailer
      {{word:common_noun|price}} on the invoices was also well above our contract rates.`,
    ),
    p(
      `{{will|Mr. Marsh}} asked that his report be kept confidential. I told him that the company will protect his identity to the
      extent possible but that an investigation will likely make the source apparent. {{will|Will}} said he understood and that he
      will cooperate fully. He also disclosed, for transparency, that he had applied for the operations manager position in 2019 and
      that he and {{john|Mr. Smith}} "have not been friends since." I note this for completeness; it does not affect the documentary
      findings below.`,
    ),
    p(
      `Preliminary review: Accounts Payable confirms fourteen {{patapsco|Patapsco}} invoices paid between January 12 and April 26,
      2024 ({{num:invoice|INV-2024-00217}} through {{num:invoice|INV-2024-05831}}), totaling $63,450.00, each approved solely by
      {{john|J. Smith}} under his $10,000 limit. The vendor was set up in our system on December 21, 2023 with a W-9 listing a
      taxpayer number ending in {{ssn_john|6789}} and the address {{addr_smith|1418 Elm Street}}, which matches
      {{john|Mr. Smith's}} home address in his personnel file. The vendor setup request was entered under {{john|Smith's}} login.`,
    ),
    p(
      `Actions: (1) {{john|Mr. Smith's}} approval authority was suspended effective {{month|May 1, 2024}}; his badge was left active
      at the direction of outside counsel so as not to alert him before interviews. (2) On {{month|May 3, 2024}} at approximately 10:40
      p.m., the operations office was entered and the vendor binders removed; the guard on duty, {{price|Darnell Price}} of
      {{ironclad|Ironclad Security}}, was injured. (3) On {{month|May 7, 2024}}, {{john|Mr. Smith}} was placed on administrative
      leave. {{john|Johnny}}, as most of the floor knows him, has not contacted the company since.`,
    ),
    p(
      `{{modal|May}} I note for the file that {{will|Mr. Marsh}} has been asked not to discuss this matter with staff, and that
      {{will|Marsh}} has complied as far as I am aware.`,
    ),
    sh("CERTIFICATION OF RECORDS CUSTODIAN"),
    p(
      `I, {{pruitt|Linda Pruitt}}, certify that I am a custodian of the personnel and compliance records of {{acme|Acme Logistics LLC}};
      that the foregoing records ({{num:bates|ACME-000101}} through {{num:bates|ACME-000103}}) are true copies of records made and kept
      in the regular course of business; and that it was the regular practice of the company to make such records.`,
      { size: 9.5 },
    ),
    p("/s/ {{pruitt|Linda Pruitt}}   Date: {{month|May 15, 2024}}", { before: 10 }),
  ],
});

// ---------------------------------------------------------------------------
// 06 Pediatric urgent-care intake for E.S. (alibi records produced by defense)
// ---------------------------------------------------------------------------
DOCS.push({
  file: "06-pediatric-intake-es.pdf",
  title: "Pediatric Urgent Care Record",
  size: 10,
  leading: 1.45,
  header: () => [
    { left: "{{clinic|HARBOR PEDIATRIC URGENT CARE}}", right: "Tel. {{num:phone|(410) 555-0155}}" },
    { left: "{{b_clinic|1100 S. Conkling Street, Baltimore, MD 21224}}", right: "NPI {{num:npi|1932145678}}" },
  ],
  footer: (n, t) => [
    { left: "CONFIDENTIAL HEALTH INFORMATION -- Defense production", right: `{{num:bates|SMITH-DEF-00001${n + 3}}}` },
    { center: `Page ${n} of ${t}` },
  ],
  blocks: [
    h("PATIENT REGISTRATION & INTAKE", { before: 0 }),
    rule(),
    kv([
      ["Patient Name:", "{{emily|SMITH, EMILY R.}}"],
      ["Preferred Name:", "\"{{emily|Emmy}}\""],
      ["DOB / Age / Sex:", "{{num:dob|02/09/2017}} / 7 y / F"],
      ["MRN / Visit Acct:", "{{num:mrn|HP-0093318}} / {{num:account|V24-118204}}"],
      ["Date of Service:", "Friday, {{month|May 3, 2024}}"],
      ["Address (current):", "{{addr_smith|1418 Elm Street, Baltimore, MD 21218}} (staying with grandparents)"],
      ["Accompanied By:", "{{john|John A. Smith}} -- grandfather -- cell {{num:phone|(410) 555-0173}}"],
      ["Caregiver Authorization:", "Consent-to-treat form on file, signed 09/2023 by mother, {{kara|Kara Delaney}}"],
    ]),
    sh("RESPONSIBLE PARTY / INSURANCE"),
    rule(),
    kv([
      ["Guarantor:", "{{steve|SMITH, STEPHEN M.}} (father)"],
      ["Guarantor SSN:", "{{ssn_steve|XXX-XX-4102}}"],
      ["Guarantor Address:", "{{addr_steve|3306 Linden Court, Apt. 2B, Towson, MD 21204}}"],
      ["Plan / Member ID:", "Tidewater Health Plan PPO / {{num:member_id|TWH-884120577}}"],
      ["Group No.:", "{{num:group|GRP-55120}}"],
      ["Subscriber:", "{{steve|Stephen Smith}} (father)"],
      ["Claim No.:", "{{num:claim|412-77-3051}}"],
      ["Copay Collected:", "$40.00 -- Visa ending {{num:card|2290}} (cardholder {{john|SMITH, JOHN}})"],
    ]),
    sh("VISIT TIMELINE (system timestamps)"),
    rule(),
    table({
      cols: [{ x: 0 }, { x: 130 }, { x: 200 }],
      head: ["Event", "Time", "Staff / Note"],
      size: 9,
      rows: [
        ["Arrival / check-in", "21:52", "Front desk, kiosk 2"],
        ["Triage", "22:04", "RN #2231 -- T 103.1 F, HR 128"],
        ["Roomed (Exam 4)", "22:31", "Grandfather at bedside"],
        ["Provider evaluation", "22:47", "{{rao|A. Rao}}, MD"],
        ["Rapid strep / CBC drawn", "22:58", "Phlebotomy -- grandfather present"],
        ["Discharge", "23:31", "Instructions to grandfather"],
      ],
    }),
    p(
      `Waiting-room camera footage is retained for 30 days and was preserved at the request of defense counsel,
      {{okafor|Lauren Okafor}} of {{firm|Okafor & Reyes LLP}}, by letter dated {{month|May 9, 2024}}.`,
      { size: 9, before: 6 },
    ),
    pageBreak(),
    h("PROVIDER NOTE", { before: 0 }),
    rule(),
    p(
      `CHIEF COMPLAINT: Fever and left ear pain x 6 hours.`,
      { font: "b" },
    ),
    p(
      `HPI: 7-year-old female ({{emily|E.S.}}) brought in by her grandfather, {{john|Mr. Smith}}, who reports that the patient complained
      of left ear pain after dinner and felt warm. Temperature at home approx. 21:30 was 103 F by oral thermometer. Grandfather gave no
      antipyretic prior to arrival. No vomiting, no rash, no neck stiffness. Patient attends first grade; per {{john|Mr. Smith}}, a
      classmate had "an ear thing" last week. Immunizations up to date per grandfather.`,
    ),
    p(
      `Father, {{steve|Steve}}, was reached by phone at 22:15 at {{num:phone|(443) 555-0129}} and verbally consented to blood draw. Father
      stated he was "out driving" and would meet them at home. Mother not reached (voicemail).`,
    ),
    p(
      `EXAM: Alert, mildly ill-appearing, consolable. L TM erythematous and bulging with loss of landmarks; R TM clear. Oropharynx mildly
      erythematous without exudate. Neck supple. Lungs clear. Wt 23.4 kg.`,
    ),
    p(
      `RESULTS: Rapid strep negative. CBC: WBC 14.2 with left shift. ASSESSMENT: Acute otitis media, left (H66.92). PLAN: Amoxicillin
      90 mg/kg/day divided BID x 10 days; ibuprofen 10 mg/kg q6h prn. Return precautions reviewed. Follow up with pediatrician in 48-72
      hours.`,
    ),
    p(
      `DISPOSITION: Discharged home in stable condition at 23:31 with grandfather. Discharge instructions reviewed with
      {{john|Mr. Smith}}, who verbalized understanding and stated that the patient's father would pick up the prescription
      in the morning. Patient's guardian of record on file: {{kara|K. Delaney}} (mother); {{steve|S. Smith}} (father).`,
    ),
    sh("ATTESTATION"),
    p(
      `I personally evaluated this patient and agree with the triage documentation. Grandfather was present in the exam room for the
      entire provider encounter (22:47 to 23:12).`,
    ),
    p("Electronically signed: {{rao|Anand Rao}}, MD -- 05/03/2024 23:44 -- DEA {{num:dea|FR4471023}}", { before: 8, font: "b" }),
    p(
      `Records certification: The foregoing is a true copy of the medical record of patient {{emily|E.S.}} maintained by
      {{clinic|Harbor Pediatric Urgent Care}}. Released to counsel for the defendant pursuant to written authorization of the patient's
      parent, {{steve|Stephen M. Smith}}, dated {{month|May 8, 2024}}. Questions regarding this record may be directed to
      {{rao|Dr. Rao}} or to the Medical Records office.`,
      { size: 9, before: 10 },
    ),
  ],
});

// ---------------------------------------------------------------------------
// 07 Defense motion (case citations: keep; this case's caption: redact)
// Real cases cited for their actual holdings: Neil v. Biggers, Manson v.
// Brathwaite, Crawford, Davis, Brady, Kyles. Fictional: Smith v. Jones,
// Smith v. State, Price v. State, United States v. Marsh.
// ---------------------------------------------------------------------------
DOCS.push({
  file: "07-defense-motion-in-limine.pdf",
  title: "Defense Motion in Limine",
  size: 11.5,
  leading: 1.9,
  header: pleadingHeader("Defendant's Motion in Limine and to Compel"),
  footer: pageOf,
  blocks: [
    caption([
      ["STATE OF MARYLAND", "IN THE"],
      ["", "CIRCUIT COURT"],
      ["v.", "FOR"],
      ["{{john|JOHN A. SMITH}},", "BALTIMORE CITY"],
      ["Defendant.", `Case No. ${CASE_NO}`],
    ]),
    p("* * * * * * * * * * * * * * * * * * * * * *", { align: "center", before: 6 }),
    h(
      "DEFENDANT'S MOTION IN LIMINE TO EXCLUDE IDENTIFICATION TESTIMONY OF {{may|MAY CHEN}} AND TO COMPEL PRODUCTION OF EXCULPATORY EVIDENCE",
    ),
    p(
      `Defendant {{john|John A. Smith}}, through undersigned counsel, {{okafor|Lauren Okafor}} and {{firm|Okafor & Reyes LLP}}, moves
      this Court (1) to exclude any testimony by {{may|May Chen}} identifying the Defendant as the driver of a pickup truck on the night
      of {{month|May 3, 2024}}, and (2) to compel the State to produce exculpatory evidence under Maryland Rule 4-263 and
      {{cite|Brady v. Maryland, 373 U.S. 83 (1963)}}. In support, the Defendant states:`,
      { indent: 36 },
    ),
    sh("I. BACKGROUND"),
    p(
      `The State's case on Counts Two and Three rests on a single inference: that because {{john|Mr. Smith's}} access badge was used at
      the {{acme|Acme Logistics}} warehouse at 10:37 p.m., {{john|Mr. Smith}} must have been the one holding it. The State offers two
      pieces of evidence to bridge that gap. The first is {{may|Ms. Chen}}, a neighbor at {{addr_chen|1420 Elm Street}}, who told
      {{det|Detective Kowalski}} that she saw "{{john|Mr. Smith}}" back out of the driveway at about 10:05 p.m. The second is the
      absence of any other badge activity that night.`,
      { indent: 36 },
    ),
    p(
      `Neither bridge holds. Records of {{clinic|Harbor Pediatric Urgent Care}}, produced to the State on {{month|May 20, 2024}}, show
      that {{john|Mr. Smith}} checked in his seven-year-old granddaughter, {{emily|E.S.}}, at 9:52 p.m. and that he was in the exam room
      continuously from 10:31 p.m. until discharge at 11:31 p.m. The attending physician attested that the grandfather was present for
      the entire provider encounter. The clinic is roughly twenty minutes from the warehouse.`,
      { indent: 36 },
    ),
    p(
      `Meanwhile, the Defendant's adult son, {{steve|Stephen Smith}}, testified at his {{month|May 30, 2024}} deposition that he took
      his father's pickup truck from the {{addr_smith|Elm Street}} driveway at about 10:00 p.m., that his father's badge lanyard hung on
      the same hook as the truck keys, and that he returned at about 11:45 p.m., wearing a dark jacket and an Orioles cap. He is roughly
      the Defendant's height and build. The younger {{steve|Mr. Smith}} worked nights at the same warehouse in 2022 and knew the route
      from the dock to the operations office. To be clear, the Defendant does not accuse his son of anything. But {{steve|Steve's}}
      testimony makes {{may|Ms. Chen's}} identification of "{{john|Mr. Smith}}" exactly as consistent with one man as with the other.`,
      { indent: 36 },
    ),
    sh("II. {{may|MS. CHEN'S}} IDENTIFICATION TESTIMONY SHOULD BE EXCLUDED"),
    p(
      `Due process forbids the admission of identification evidence that is so unreliable that it creates a very substantial
      likelihood of misidentification. {{cite|Manson v. Brathwaite, 432 U.S. 98 (1977)}}. The reliability factors are familiar: the
      witness's opportunity to view the person, her degree of attention, the accuracy of any prior description, her level of
      certainty, and the time between the event and the identification. {{cite|Neil v. Biggers, 409 U.S. 188 (1972)}}. The Supreme
      Court applied the same totality-of-the-circumstances approach to a neighbor's after-dark recognition testimony in
      {{cite|Smith v. Jones, 512 U.S. 218 (1994)}}, holding that familiarity with a person "does not cure an observation that never
      included his face." {{cite|Smith, 512 U.S. at 224}}.`,
      { indent: 36 },
    ),
    p(
      `Every factor cuts against reliability here. {{may|Ms. Chen}} saw the driver from behind, at night, while carrying trash to the
      curb, from a distance she estimated at forty feet. She described only a man in a baseball cap. She told police she assumed the
      driver was "{{john|John}}, the father," because "{{steve|Steve}} doesn't live there anymore," which is an inference about who
      ordinarily drives the truck, not an observation of who drove it. Under {{cite|Smith's}} reasoning, a witness who infers identity
      from the vehicle rather than the person has not identified anyone at all. {{cite|Id. at 226}}. Maryland courts have excluded
      recognition testimony on similar facts. See {{cite|Smith v. State, 158 Md. App. 673, 690 (2004)}} (neighbor's identification of
      "the man from next door" inadmissible where witness conceded she saw only his back).`,
      { indent: 36 },
    ),
    p(
      `Nor is the testimony admissible as lay opinion under Maryland Rule 5-701. A lay opinion about identity must be rationally based on
      the witness's own perception. {{may|Ms. Chen's}} statement that she saw "{{john|Mr. Smith}}" is a conclusion drawn from the truck,
      the hour, and her expectations. See {{cite|United States v. Marsh, 451 F.3d 712, 719 (4th Cir. 2006)}} (lay identification
      testimony excluded where witness "recognized the car, not the driver"). At a minimum, the State should be precluded from eliciting
      the words "{{john|Mr. Smith}}" from {{may|Ms. Chen}} without first establishing, outside the jury's presence, which
      {{john|Mr. Smith}} she claims to have seen and on what basis.`,
      { indent: 36 },
    ),
    sh("III. ANY OUT-OF-COURT STATEMENT BY {{may|MS. CHEN}} IS TESTIMONIAL"),
    p(
      `{{may|Ms. Chen's}} written statement was taken by a police officer during a canvass, a day after the incident, for the purpose of
      establishing past events relevant to a prosecution. It is testimonial. {{cite|Crawford v. Washington, 541 U.S. 36, 68 (2004)}};
      {{cite|Davis v. Washington, 547 U.S. 813, 822 (2006)}}. If {{may|Ms. Chen}} does not testify and submit to cross-examination,
      the statement is inadmissible for any purpose, including through {{det|Detective Kowalski}} or the reporting officer,
      {{ofc_chen|Officer Chen}}, who is no relation to the witness.`,
      { indent: 36 },
    ),
    sh("IV. THE STATE MUST PRODUCE EXCULPATORY EVIDENCE"),
    p(
      `The State's disclosure obligation extends to favorable evidence known to the police, whether or not the prosecutor has seen it.
      {{cite|Kyles v. Whitley, 514 U.S. 419, 437-38 (1995)}}; {{cite|Price v. State, 82 Md. App. 59, 65 (1990)}}. The Defendant
      specifically requests:`,
      { indent: 36 },
    ),
    p(
      `(a) the complete door-access log for {{month|May 3, 2024}} for every badge, including badge {{num:badge|A-17702}} assigned to
      {{will|William Marsh}}, who reported the {{patapsco|Patapsco}} invoices, who had a documented grievance against the Defendant,
      and who badged into the building at 11:19 p.m.;`,
      { left: 36 },
    ),
    p(
      `(b) the results of latent-print analysis of the screwdriver recovered from the operations office (ECU Item 5);`,
      { left: 36 },
    ),
    p(
      `(c) all records concerning the out-of-service dock camera (CAM-07), including work order {{num:work_order|WO-24-0613}} and the
      identity of the person who reported the outage;`,
      { left: 36 },
    ),
    p(
      `(d) the instructions given to teller {{rosa|Rosa Delgado}} before the photo array, the array itself, and any notes of her
      confidence statement, which the State's own report records as "about ninety percent"; and`,
      { left: 36 },
    ),
    p(
      `(e) any statement by the victim, {{price|Darnell Price}}, describing the intruder, including any statement that the intruder
      appeared younger than sixty. {{price|Mr. Price}} has told defense investigators that the man "moved fast, like a younger guy."`,
      { left: 36 },
    ),
    p(
      `The defense has asked for these items informally on three occasions. The State's response that it "will produce what it has
      when it has it" does not satisfy Rule 4-263, and the motions hearing is set for September 12, 2024.`,
      { indent: 36 },
    ),
    sh("V. CONCLUSION"),
    p(
      `For these reasons, the Defendant asks the Court to exclude {{may|Ms. Chen's}} identification testimony, or in the alternative to
      hold a pretrial hearing on its admissibility, and to order the State to produce the materials listed in Part IV within fourteen
      days.`,
      { indent: 36 },
    ),
    p("Respectfully submitted,", { left: 252, before: 12 }),
    p("/s/ {{okafor|Lauren Okafor}}", { left: 252, before: 12 }),
    p("{{okafor|Lauren Okafor}}, CPF No. {{num:bar|1012150219}}", { left: 252, before: 0, size: 10.5 }),
    p("{{firm|Okafor & Reyes LLP}}", { left: 252, before: 0, size: 10.5 }),
    p("{{b_firm|201 N. Charles Street, Suite 1400, Baltimore, MD 21201}}", { left: 252, before: 0, size: 10.5 }),
    p("{{num:phone|(410) 555-0177}}", { left: 252, before: 0, size: 10.5 }),
    p("Counsel for Defendant", { left: 252, before: 0, size: 10.5 }),
    h("REQUEST FOR HEARING", { before: 14 }),
    p("Pursuant to Maryland Rule 4-252(g), the Defendant requests a hearing on this motion.", { indent: 36 }),
    h("CERTIFICATE OF SERVICE", { before: 14 }),
    p(
      `I HEREBY CERTIFY that on this 21st day of June, 2024, a copy of the foregoing was served through MDEC on
      {{asa|Marcus Whitfield}}, Assistant State's Attorney, {{sao|Office of the State's Attorney for Baltimore City}},
      {{b_sao|120 E. Baltimore Street, Baltimore, MD 21202}}.`,
      { indent: 36 },
    ),
    p("/s/ {{okafor|Lauren Okafor}}", { left: 252, before: 12 }),
  ],
});

// ---------------------------------------------------------------------------
// 08 Witness statement of May Chen ("May" the name vs. the month vs. the verb;
// "Chen" the witness vs. the officer)
// ---------------------------------------------------------------------------
DOCS.push({
  file: "08-witness-statement-may-chen.pdf",
  title: "Witness Statement",
  size: 10.5,
  leading: 1.6,
  header: () => [
    { left: "{{bpd|BALTIMORE POLICE DEPARTMENT}}", right: "WITNESS STATEMENT" },
    { left: "Southeastern District Detective Unit", right: "Complaint No. {{num:complaint|24-5E-018734}}" },
  ],
  footer: (n, t) => [{ left: "BPD Form 1006 -- Witness initials: ______", right: `Page ${n} of ${t}` }],
  blocks: [
    kv([
      ["Witness Name (Last, First):", "{{may|CHEN, MAY}}"],
      ["Date of Birth:", "{{num:dob|11/02/1954}}"],
      ["Home Address:", "{{addr_chen|1420 Elm Street, Baltimore, MD 21218}}"],
      ["Phone:", "{{num:phone|(410) 555-0191}}"],
      ["Date / Time of Statement:", "{{month|May 4, 2024}}, 14:20 hrs"],
      ["Location:", "Witness residence"],
      ["Taken By:", "{{ofc_chen|Ofc. K. Chen}} #{{num:badge|4471}}, in the presence of {{det|Det. B. Kowalski}} #{{num:badge|3196}}"],
    ], { labelW: 160 }),
    rule(4),
    p(
      `I, {{may|May Chen}}, give the following statement voluntarily. I have lived at {{addr_chen|1420 Elm Street}} for thirty-one years.
      My house is directly next door to the {{addr_smith|Elm Street}} house of {{john|John}} and {{mary|Mary Smith}}, on the left side if
      you are facing the street. Our driveways are side by side with a strip of grass in between. I have known the family since their
      son {{steve|Steve}} was a little boy. {{mary|Mary}} and I have coffee most Sunday mornings.`,
      { before: 8 },
    ),
    p(
      `On Friday, {{month|May 3, 2024}}, I was home alone all evening. At around a quarter to ten I heard a car door and an engine next
      door, and I think the gray Honda left, but I was in the kitchen and I did not see who was in it. Their granddaughter
      {{emily|Emily}} has been staying with them, so I assumed it was {{mary|Mary}} taking her somewhere, but I don't know that.`,
    ),
    p(
      `At about 10:05 PM I took my trash can out to the curb because Saturday is pickup. While I was at the curb I saw the silver
      pickup truck back out of the {{addr_smith|1418 Elm}} driveway. That is {{john|Mr. Smith's}} truck. He is the only one who
      drives it. The porch light at their house was off, but the streetlight is on the corner. The driver was wearing a baseball cap
      and a dark coat. I saw him from behind and from the side as he got in and backed out. I did not see his face. I waved, the way I
      always do, but he did not wave back, which I thought was strange for {{john|John}}.`,
    ),
    p(
      `I went to bed around 11:30 but I could not sleep. A little before midnight I heard the truck pull back in. I looked out my
      bedroom window, which faces their side door, and I saw {{john|Mr. Smith}} walk from the truck to the side door and go in. He
      had the same cap on. Again I only saw his back.`,
    ),
    p(
      `I did not see anyone else come or go that night. I did not notice whether the Honda came back. I did not hear any arguing.`,
    ),
    sh("QUESTIONS BY {{det|DET. KOWALSKI}} / ANSWERS BY WITNESS"),
    p("Q: When you say {{john|Mr. Smith}}, which person do you mean?", { before: 6 }),
    p(
      `A: {{john|John}}. {{john|John Smith}}, the father. {{steve|Steve}} doesn't live there anymore. He lives in Towson. I know his car,
      it's a little blue one, and I don't remember if it was there or not.`,
    ),
    p("Q: How sure are you that the driver was {{john|John Smith}}?"),
    p(
      `A: I would say pretty sure. Eighty percent. It was his truck and he was built like {{john|John}}. But {{steve|Steve}} is built like
      him too. They are both big men. I did not see a face.`,
    ),
    p("Q: How far were you from the driver?"),
    p("A: From the curb to their driveway, maybe forty feet. I had my glasses on."),
    p("Q: Are you related to {{ofc_chen|Officer Chen}}, who is taking this statement?"),
    p("A: No. We were just laughing about that. It is a common name."),
    p("Q: Is there anything else you want to add?"),
    p(
      `A: {{modal|May}} I say one thing? {{john|John}} is a good neighbor. He shoveled my walk every winter after my husband passed. I am
      only telling you what I saw. I don't want to get anybody in trouble.`,
    ),
    p("Q: Did you speak to anyone in that family about this before today?"),
    p(
      `A: No. I saw {{mary|Mrs. Smith}} this morning getting the paper but we only said good morning. She looked tired.`,
    ),
    rule(8),
    p(
      `I have read this statement consisting of 2 pages, and it is true and correct to the best of my knowledge. I gave it of my own free
      {{word:common_noun|will}}, without threats or promises.`,
      { before: 6, font: "i" },
    ),
    kv([
      ["Signature of Witness:", "/s/ {{may|May Chen}}"],
      ["Date / Time:", "05/04/2024 15:02 hrs"],
      ["Witnessed By:", "{{ofc_chen|K. Chen}} #{{num:badge|4471}} -- {{det|B. Kowalski}} #{{num:badge|3196}}"],
      ["Reviewed:", "Southeastern District DDU -- 05/06/2024"],
    ], { labelW: 160, before: 8 }),
    p(
      `Investigator's note: Witness {{may|CHEN}} is not related to reporting officer {{ofc_chen|CHEN}}. Witness wears corrective lenses
      and states her vision is "fine with glasses." Distance from witness's curb to the {{addr_smith|1418 Elm Street}} driveway apron measured on
      {{month|May 9}} at 38 feet. Nearest streetlight is 112 feet from the driveway.`,
      { size: 9, before: 10 },
    ),
  ],
});

// ---------------------------------------------------------------------------
// 09 Letter from Will Marsh ("Will" the name vs. "will" the verb/noun;
// home return address vs. "Smith Avenue" business address)
// ---------------------------------------------------------------------------
DOCS.push({
  file: "09-letter-will-marsh.pdf",
  title: "Witness Correspondence",
  size: 11,
  leading: 1.5,
  footer: (n, t) => (n === 1 ? [] : [{ right: `Page ${n} of ${t}` }]),
  blocks: [
    p("{{will|William J. Marsh}}", { before: 0, font: "b" }),
    p("{{addr_marsh|52 Harbor View Lane}}", { before: 0 }),
    p("{{addr_marsh|Dundalk, MD 21222}}", { before: 0 }),
    p("{{month|May 28, 2024}}", { before: 14 }),
    p("{{asa|Marcus Whitfield}}, Assistant State's Attorney", { before: 14 }),
    p("{{sao|Office of the State's Attorney for Baltimore City}}", { before: 0 }),
    p("{{b_sao|120 E. Baltimore Street}}", { before: 0 }),
    p("Baltimore, MD 21202", { before: 0 }),
    p(`Re: State v. {{john|John Smith}}, Case No. ${CASE_NO}`, { before: 14, font: "b" }),
    p(`Dear {{asa|Mr. Whitfield}}:`, { before: 14 }),
    p(
      `Thank you for meeting with me last week. You asked me to put a few things in writing, so here they are. I {{modal|will}} try to
      keep it to what I know firsthand, and I {{modal|will}} say up front that I have not talked to {{john|John}} since this started,
      on the advice of the company.`,
    ),
    p(
      `First, about the invoices. I am the night shift supervisor at the Holabird warehouse. In April a dispatcher from one of our
      regular carriers asked me who {{patapsco|Patapsco Freight}} was, because he had never seen one of their trucks in our yard. I
      checked the gate logs for every date on the {{patapsco|Patapsco}} invoices and found nothing. I also noticed the
      {{word:common_noun|price}} per trailer was about forty percent above what we pay anyone else. On April 29 I took what I had to
      {{pruitt|Linda Pruitt}} in compliance at our {{b_acme|Smith Avenue}} headquarters. That is all I did. I did not accuse anybody by
      name. The approvals had {{john|Mr. Smith's}} initials on them, so I guess the name was obvious.`,
    ),
    p(
      `Second, I know the defense is going to say I had a grudge. I {{modal|will}} not pretend we were close. I wanted the operations
      job in 2019 and {{john|Johnny}} got it. I was sore about it for a while. At the company cookout in July 2022 I made a dumb joke
      about how one day {{john|Johnny}} {{modal|will}} slip up and I {{modal|will}} be right there to take his job. People laughed,
      including him. I regret saying it now. But a bad joke two years ago is not a reason to steal from your own company, and it is not
      a reason to make up a vendor problem that the bank records {{modal|will}} either prove or disprove.`,
    ),
    p(
      `Third, the night of {{month|May 3}}. I was not at work. I was home in Dundalk with my wife, {{carla|Carla}}, from about 6:30 PM
      on. We watched the Orioles game and went to bed after the eleven o'clock news. {{carla|Carla Marsh}} {{modal|will}} confirm that,
      and so {{modal|will}} my phone, which was on our home Wi-Fi all night. At 10:58 PM {{ironclad|Ironclad}} dispatch called me as the
      on-call supervisor because {{price|Darnell}} had been hurt. I got dressed and drove straight over. I badged in at the rear dock at
      11:19 PM. That {{modal|will}} be in the badge log. The police were already there.`,
    ),
    p(
      `When I got upstairs, the {{patapsco|Patapsco}} binder was gone, and so was a second binder and the office laptop. I told
      {{ofc_chen|Officer Chen}} that, and I told him I would pull whatever records he needed. I also told him the dock camera
      had been down since the first of the month. I had put in the work order myself on {{month|May 1}}. I want that to be clear,
      because I have heard secondhand that somebody thinks it is suspicious. It is not. That camera goes down every spring.`,
    ),
    p(
      `Fourth, {{price|Darnell}}. {{price|Darnell Price}} has worked the overnight post at our building for six years and he is a
      friend. I visited {{price|Mr. Price}} at home the following week. He told me he did not get a good look at the man's face but that
      he "moved fast." I am passing that along because I think you should hear it, even if it does not help the case.`,
    ),
    p(
      `Last, about {{steve|Steve}}. I trained {{steve|Steve Smith}} on nights in 2022. He was a good worker and I have nothing bad to
      say about him. I know he knows the building. So do about two hundred other people. {{modal|Will}} anyone be asking where those
      people were? I am not trying to point at anybody. I just want the same questions asked of everyone that were asked of me.`,
    ),
    p(
      `If you need me to testify, I {{modal|will}}. My shift starts at 6 PM, so mornings are best. My cell is
      {{num:phone|(410) 555-0164}}.`,
    ),
    p("Sincerely,", { before: 14 }),
    p("/s/ {{will|Will Marsh}}", { before: 18 }),
    p("{{will|William J. Marsh}}", { before: 0 }),
    p("cc: {{okafor|Lauren Okafor}}, Esq., {{firm|Okafor & Reyes LLP}} (at the request of the State, per discovery obligations)", { before: 14, size: 9.5 }),
  ],
});

// ---------------------------------------------------------------------------
// 10 Scheduling order (judge, clerk, courthouse address: keep)
// ---------------------------------------------------------------------------
DOCS.push({
  file: "10-scheduling-order.pdf",
  title: "Scheduling Order",
  size: 11.5,
  leading: 1.75,
  header: pleadingHeader("Scheduling Order"),
  footer: pageOf,
  blocks: [
    caption([
      ["STATE OF MARYLAND", "IN THE"],
      ["", "CIRCUIT COURT"],
      ["v.", "FOR"],
      ["{{john|JOHN A. SMITH}},", "BALTIMORE CITY"],
      ["Defendant.", `Case No. ${CASE_NO}`],
    ]),
    p("* * * * * * * * * * * * * * * * * * * * * *", { align: "center", before: 6 }),
    h("SCHEDULING ORDER AND ORDER CONCERNING PRIVACY OF FILINGS"),
    p(
      `Upon the arraignment of the Defendant, {{john|John A. Smith}}, on {{month|May 28, 2024}}, the entry of appearance of
      {{okafor|Lauren Okafor}}, Esquire, as counsel for the Defendant, and the parties' joint request for a scheduling conference, it is
      this 24th day of June, 2024, by the {{court|Circuit Court for Baltimore City}}, hereby ORDERED:`,
      { indent: 36 },
    ),
    p(
      `1. Motions. The State shall respond to the Defendant's Motion in Limine and to Compel on or before July 8, 2024. A motions hearing
      is set for September 12, 2024, at 9:30 a.m., in Courtroom 405, Clarence M. Mitchell, Jr. Courthouse,
      {{b_court|100 N. Calvert Street, Baltimore, MD 21202}}.`,
      { indent: 36 },
    ),
    p(
      `2. Discovery. The State shall complete its disclosures under Maryland Rule 4-263, including the complete door-access log for
      {{month|May 3, 2024}}, latent-print results, and photo-array materials, on or before August 9, 2024. The Defendant's alibi
      disclosure filed {{month|May 21, 2024}} is deemed timely.`,
      { indent: 36 },
    ),
    p(
      `3. Preserved testimony. The deposition of {{steve|Stephen M. Smith}}, taken {{month|May 30, 2024}} under Maryland Rule 4-261, may
      be offered at trial by either party upon a showing that {{steve|Mr. Smith}} is unavailable within the meaning of Rule 4-261(e).`,
      { indent: 36 },
    ),
    p(
      `4. Trial. A pretrial conference is set for April 17, 2025, at 2:00 p.m. Jury trial is set to begin {{month|May 12, 2025}}, at
      9:30 a.m., and is expected to last four days. Counsel shall exchange proposed voir dire and jury instructions by
      {{month|May 1, 2025}}.`,
      { indent: 36 },
    ),
    p(
      `5. Victim's rights. The State shall provide notice of all proceedings to the victim, {{price|Darnell Price}}, in accordance with
      Md. Code Ann., Crim. Proc. § 11-104, and shall inform the Court at the motions hearing whether {{price|Mr. Price}} has requested
      to be heard.`,
      { indent: 36 },
    ),
    p(
      `6. Privacy of filings. In every paper filed in this action, the parties shall (a) identify the minor child referenced in the
      record only by the initials "{{emily|E.S.}}"; (b) omit Social Security numbers, including partial or truncated numbers; (c) omit
      the home addresses of witnesses; and (d) omit financial account numbers except the last four digits. The Clerk is directed to
      seal the unredacted transcript of the {{month|May 30, 2024}} deposition and to accept for the public file only the redacted
      version submitted by the parties.`,
      { indent: 36 },
    ),
    p(
      `7. Continuances. No date set in this Order {{modal|will}} be postponed except upon written motion showing good cause.`,
      { indent: 36 },
    ),
    p("/s/ {{judge|Patricia Alvarez}}", { left: 252, before: 18 }),
    p("{{judge|Judge Patricia Alvarez}}", { left: 252, before: 0 }),
    p("{{court|Circuit Court for Baltimore City}}", { left: 252, before: 0, size: 10.5 }),
    p("Chambers: {{num:phone|(410) 555-0108}}", { left: 252, before: 0, size: 10.5 }),
    p("Entered by: {{clerk|Andrea Ferris}}, Courtroom Clerk to {{judge|Judge Alvarez}} -- 06/24/2024", { before: 14, size: 10 }),
    p("Copies to:", { before: 10, size: 10, font: "b" }),
    p(
      "{{asa|Marcus Whitfield}}, Assistant State's Attorney, {{sao|Office of the State's Attorney for Baltimore City}}",
      { left: 18, before: 0, size: 10 },
    ),
    p("{{okafor|Lauren Okafor}}, Esquire, {{firm|Okafor & Reyes LLP}}", { left: 18, before: 0, size: 10 }),
    p("Victim/Witness Unit (for notice to the victim)", { left: 18, before: 0, size: 10 }),
  ],
});

// ---------------------------------------------------------------------------
// Render + ground truth
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date("2024-06-14T12:00:00Z");

interface Drawn extends Item {
  y: number;
  region?: "header" | "footer";
}

function headerItems(
  hl: HeaderLine[],
  fonts: Fonts,
  yTop: number,
  size: number,
  step: number,
  region: "header" | "footer",
): Drawn[] {
  const out: Drawn[] = [];
  hl.forEach((ln, k) => {
    const y = yTop - k * step;
    const parts: [string | undefined, Align][] = [
      [ln.left, "left"],
      [ln.center, "center"],
      [ln.right, "right"],
    ];
    for (const [src, align] of parts) {
      if (!src) continue;
      const run = parse(src);
      const x = measureAlign(fonts.r, run.text, size, MARGIN_L, BODY_W, align);
      out.push({ x, y, text: run.text, font: fonts.r, size, run, at: 0, region });
    }
  });
  return out;
}

async function build(doc: DocSpec): Promise<{ bytes: Uint8Array; spans: TruthSpan[]; pages: number }> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    r: await pdf.embedFont(StandardFonts.Helvetica),
    b: await pdf.embedFont(StandardFonts.HelveticaBold),
    i: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  pdf.setTitle(doc.title);
  pdf.setCreator("redaction-action eval corpus generator");
  pdf.setProducer("pdf-lib");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  // Two passes: resolve "@@MARKER@@" placeholders (e.g. a transcript index) to page numbers.
  let pages = paginate(doc, layoutBlocks(doc, fonts));
  const markers = new Map<string, number>();
  pages.forEach((pg, i) => pg.forEach((pl) => pl.line.marker && markers.set(pl.line.marker, i + 1)));
  if (markers.size) {
    let json = JSON.stringify(doc.blocks);
    for (const [name, pg] of markers) json = json.split(`@@${name}@@`).join(String(pg));
    if (json.includes("@@")) throw new Error(`${doc.file}: unresolved @@marker@@ placeholder`);
    const resolved: DocSpec = { ...doc, blocks: JSON.parse(json) as Block[] };
    pages = paginate(resolved, layoutBlocks(resolved, fonts));
  }
  const total = pages.length;
  const spans: TruthSpan[] = [];

  pages.forEach((placed, pi) => {
    const pageNo = pi + 1;
    const page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
    const drawn: Drawn[] = [];
    const rules: number[] = [];

    drawn.push(...headerItems(doc.header?.(pageNo, total) ?? [], fonts, 752, 9, 12, "header"));
    for (const pl of placed) {
      if (doc.numbered && pl.slot !== undefined) {
        const n = String(pl.slot + 1);
        drawn.push({ x: NUM_X - fonts.r.widthOfTextAtSize(n, 10), y: pl.baseline, text: n, font: fonts.r, size: 10 });
      }
      if (pl.line.rule) rules.push(pl.baseline + 4);
      for (const it of pl.line.items) drawn.push({ ...it, y: pl.baseline });
    }
    drawn.push(...headerItems(doc.footer?.(pageNo, total) ?? [], fonts, 50, 8.5, 11, "footer"));

    // Draw strictly in order and build the whitespace-collapsed page text.
    let pageText = "";
    const pending: {
      pos: number;
      text: string;
      key: string;
      kind?: string;
      wrapped: boolean;
      region?: "header" | "footer";
    }[] = [];
    for (const d of drawn) {
      if (!d.text) continue;
      if (/\s{2,}|^\s|\s$/.test(d.text)) throw new Error(`Unnormalized drawn text: "${d.text}"`);
      page.drawText(d.text, { x: d.x, y: d.y, size: d.size, font: d.font, color: rgb(0, 0, 0) });
      if (pageText) pageText += " ";
      const base = pageText.length;
      pageText += d.text;
      if (d.run && d.at !== undefined) {
        const end = d.at + d.text.length;
        for (const sp of d.run.spans) {
          if (sp.s < d.at || sp.s >= end) continue;
          pending.push({
            pos: base + (sp.s - d.at),
            text: d.run.text.slice(sp.s, sp.e),
            key: sp.key,
            kind: sp.kind,
            wrapped: sp.e > end,
            region: d.region,
          });
        }
      }
    }
    for (const y of rules) {
      page.drawLine({ start: { x: MARGIN_L, y }, end: { x: PAGE_W - MARGIN_R, y }, thickness: 0.6, color: rgb(0, 0, 0) });
    }

    for (const pd of pending) {
      if (!pageText.startsWith(pd.text, pd.pos)) {
        throw new Error(`${doc.file} p${pageNo}: span "${pd.text}" not contiguous in page text (page break inside span?)`);
      }
      let occurrence = 0;
      for (let i = pageText.indexOf(pd.text); i !== -1 && i < pd.pos; i = pageText.indexOf(pd.text, i + 1)) occurrence++;
      const c = classify(pd.key, pd.kind, pd.text);
      const span: TruthSpan = {
        page: pageNo,
        text: pd.text,
        occurrence,
        expected: c.expected,
        category: c.category,
        start: pd.pos,
      };
      if ("entityId" in c && c.entityId) span.entityId = c.entityId;
      if ("ambiguous" in c && c.ambiguous) span.ambiguous = true;
      if (c.kind) span.kind = c.kind;
      if (pd.wrapped) span.wrapped = true;
      if (pd.region) span.region = pd.region;
      spans.push(span);
    }
  });

  const bytes = await pdf.save({ useObjectStreams: false });
  spans.sort((a, b) => a.page - b.page || a.start - b.start);
  return { bytes, spans, pages: total };
}

function validSsn(ssn: string) {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(ssn);
  if (!m) return false;
  const area = Number(m[1]);
  return area >= 1 && area <= 899 && area !== 666 && m[2] !== "00" && m[3] !== "0000";
}

for (const e of ENTITIES) {
  if (e.type === "ssn" && !validSsn(e.canonical)) throw new Error(`Invalid SSN format for ${e.id}: ${e.canonical}`);
  if (ENTITIES.filter((x) => x.key === e.key || x.id === e.id).length > 1) throw new Error(`Duplicate entity ${e.key}`);
}

await rm(PDF_DIR, { recursive: true, force: true });
await mkdir(PDF_DIR, { recursive: true });

const documents: { file: string; title: string; pages: number; spans: TruthSpan[] }[] = [];
for (const doc of DOCS) {
  const { bytes, spans, pages } = await build(doc);
  await writeFile(path.join(PDF_DIR, doc.file), bytes);
  documents.push({ file: doc.file, title: doc.title, pages, spans });
}

const allSpans = documents.flatMap((d) => d.spans);
const entities = ENTITIES.map((e) => {
  const mine = allSpans.filter((s) => s.entityId === e.id);
  return {
    id: e.id,
    type: e.type,
    canonical: e.canonical,
    redact: e.redact,
    note: e.note,
    mentions: mine.length,
    aliases: [...new Set(mine.map((s) => s.text))].sort(),
  };
});
const unused = entities.filter((e) => e.mentions === 0).map((e) => e.id);
if (unused.length) console.warn(`warning: entities never mentioned: ${unused.join(", ")}`);

const truth = {
  version: 1,
  policy:
    "REDACT names of private individuals (parties, witnesses, victims, family, minors, and any other named private person) in every variant; " +
    "their home/residential addresses (full or partial street references); and SSNs in every form (full, undashed, spaced, masked, last-four). " +
    "KEEP names inside citations to other cases, judges and court staff, attorneys of record, police acting officially, organizations and " +
    "their business addresses, and all other numbers (phones, case/account/routing/EIN/Bates/invoice/claim numbers, dates, DOBs).",
  occurrenceRule:
    "Page text = mupdf toStructuredText('preserve-whitespace').asText() with every whitespace run collapsed to one space and trimmed. " +
    "occurrence = number of earlier start positions (case-sensitive, overlapping, plain substring) of the exact span text on that page. " +
    "start = char offset of the span in that normalized page text.",
  entities,
  documents,
};
await writeFile(path.join(OUT_DIR, "truth.json"), JSON.stringify(truth, null, 2) + "\n");

const byCat = new Map<string, number>();
for (const s of allSpans) byCat.set(`${s.expected}/${s.category}`, (byCat.get(`${s.expected}/${s.category}`) ?? 0) + 1);
console.log(`docs: ${documents.length}, pages: ${documents.reduce((n, d) => n + d.pages, 0)}, spans: ${allSpans.length}`);
for (const d of documents) console.log(`  ${d.file.padEnd(36)} ${String(d.pages).padStart(3)}p ${String(d.spans.length).padStart(5)} spans`);
for (const [k, v] of [...byCat.entries()].sort()) console.log(`  ${k.padEnd(28)} ${v}`);
console.log(
  `  ambiguous: ${allSpans.filter((s) => s.ambiguous).length}, wrapped: ${allSpans.filter((s) => s.wrapped).length}`,
);
