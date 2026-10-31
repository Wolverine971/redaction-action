import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import {
  STATE_LABEL,
  type CandidateState,
  type ReportCandidate,
  type ReportData,
  type ReportEvent,
  type ReportPlace,
  type ReportRetired,
} from "@/lib/report-types";

/**
 * Renders the internal "Redaction report" for a batch: what the system flagged, what a reviewer
 * redacted or kept (and who decided when), then each entity's own history and every place it
 * appears (split into visible and redacted when a reviewer made exceptions), entities no longer in
 * the results, places not tied to an entity, and the full audit trail. US Letter, portrait.
 *
 * Pure: no database, no Next.js. Uses pdf-lib's standard fonts, so every string goes through
 * `sanitizeText` first (WinAnsi only). Times are shown in `options.timeZone` (an IANA name),
 * falling back to the server's zone.
 */
export async function renderReportPdf(data: ReportData, options: { timeZone?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const time = timeFormatter(options.timeZone);
  const batchName = sanitizeText(data?.batch?.name) || "Untitled batch";
  const generatedAt = toDate(data?.generatedAt);

  doc.setTitle(`Redaction report — ${batchName}`);
  doc.setSubject("Internal: contains the redacted information.");
  doc.setCreator("Redaction Action");
  doc.setProducer("Redaction Action");
  if (generatedAt) {
    doc.setCreationDate(generatedAt);
    doc.setModificationDate(generatedAt);
  }

  const w = new Writer(doc, fonts);
  const candidates = list<ReportCandidate>(data?.candidates);
  const byState = (state: CandidateState) => candidates.filter((c) => stateOf(c) === state);
  const retired = list<ReportRetired>(data?.retired);
  const unassigned = list<ReportPlace>(data?.unassigned);

  drawTitle(w, data, batchName, time);
  drawSummary(w, data, time);
  for (const state of STATE_ORDER) drawCandidateSection(w, state, byState(state), time);
  drawEntityHistories(w, STATE_ORDER.map((state) => ({ state, rows: byState(state) })), time);
  if (retired.length) drawRetired(w, retired, time);
  if (unassigned.length) drawUnassigned(w, unassigned, time);
  drawAuditTrail(w, list<ReportData["events"][number]>(data?.events), time);

  drawChrome(w, batchName, `Generated ${time.dateTime(data?.generatedAt, { zone: true })}`);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Page geometry and palette
// ---------------------------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const CONTENT_W = PAGE_W - MARGIN_X * 2; // 504
const BODY_TOP = 702;
const BODY_BOTTOM = 66;

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

/** Mirrors the review UI (globals.css + the Redact/Keep toggle). */
const COLOR = {
  ink: hex("#141414"),
  text: hex("#1c1b19"),
  muted: hex("#6f6b63"),
  line: hex("#e3e0d9"),
  rule: hex("#bdb8ae"),
  wash: hex("#f6f5f2"),
  white: rgb(1, 1, 1),
  warn: hex("#92400e"),
  /** Text color for "visible" outcomes; a shade darker than the Keep green so it reads as text. */
  visible: hex("#047857"),
  internalFill: hex("#fbeeee"),
  internalBar: hex("#b42318"),
  internalText: hex("#7a1a12"),
};

interface TagStyle {
  fill: RGB;
  text: RGB;
  border?: RGB;
}

const STATE_STYLE: Record<CandidateState, TagStyle> = {
  flagged: { fill: hex("#e5e5e5"), text: hex("#404040"), border: hex("#cfcfcf") },
  redacted: { fill: COLOR.ink, text: COLOR.white },
  kept: { fill: hex("#059669"), text: COLOR.white },
};

/** Swatch colors for the two outcomes of a single place. */
const OUTCOME_STYLE: Record<Outcome, TagStyle> = { visible: STATE_STYLE.kept, redacted: STATE_STYLE.redacted };

/** Same order everywhere: the state sections, and the entity histories after them. */
const STATE_ORDER = ["kept", "redacted", "flagged"] as const;

const SECTION: Record<CandidateState, { title: string; description: string }> = {
  kept: {
    title: "You kept",
    description: "A reviewer chose to leave these visible. They appear unredacted in the shared documents.",
  },
  redacted: {
    title: "You redacted",
    description: "A reviewer confirmed these should be redacted.",
  },
  flagged: {
    title: "System flagged (redacted by default)",
    description: "Found by the system and redacted by default. No reviewer looked at these individually.",
  },
};

const TYPE_LABEL: Record<string, { one: string; many: string; column: string }> = {
  person: { one: "person", many: "people", column: "Person" },
  org: { one: "organization", many: "organizations", column: "Organization" },
  address: { one: "address", many: "addresses", column: "Address" },
  ssn: { one: "SSN", many: "SSNs", column: "SSN" },
};

// ---------------------------------------------------------------------------
// Text sanitizing (standard PDF fonts only encode WinAnsi)
// ---------------------------------------------------------------------------

/** Every code point Helvetica can draw with WinAnsi encoding: ASCII, Latin-1, and 27 extras. */
const WIN_ANSI = new Set<number>([
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff),
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Look-alikes for characters WinAnsi can't encode. Curly quotes, dashes, • and … are encodable and kept. */
const REPLACE: Record<string, string> = {
  "\u00a0": " ", "\u00ad": "", "\u2028": " ", "\u2029": " ", "\u202f": " ", "\u205f": " ", "\u3000": " ",
  "\u200b": "", "\u200c": "", "\u200d": "", "\u2060": "", "\ufeff": "",
  "‐": "-", "‑": "-", "‒": "–", "―": "—", "−": "-", "⁃": "-",
  "′": "'", "″": '"', "‛": "’", "‟": "”", "‵": "'", "＂": '"',
  "←": "<-", "→": "->", "↔": "<->", "⇐": "<=", "⇒": "=>", "⇔": "<=>",
  "↑": "^", "↓": "v", "➜": "->", "➔": "->", "➡": "->", "↩": "<-", "↪": "->",
  "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "∼": "~",
  "●": "•", "◦": "•", "‣": "•", "∙": "·", "⋅": "·", "▪": "•", "■": "•",
  "✓": "x", "✔": "x", "✗": "x", "✘": "x", "№": "No.", "⁄": "/",
};

/**
 * Makes a string drawable with Helvetica: keeps WinAnsi characters (accents like á é ñ, curly
 * quotes, dashes), maps common look-alikes (arrows, odd spaces and dashes), strips accents it can't
 * draw, and drops the rest. Collapses whitespace to single spaces. Never throws.
 */
export function sanitizeText(value: unknown): string {
  let out = "";
  for (const ch of text(value).normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += " ";
    else if (cp === 0xa0 || cp === 0xad) out += REPLACE[ch];
    else if (WIN_ANSI.has(cp)) out += ch;
    else if (ch in REPLACE) out += REPLACE[ch];
    else if (/\s/u.test(ch)) out += " ";
    else out += fallback(ch);
  }
  return out.replace(/ {2,}/g, " ").trim();
}

function fallback(ch: string): string {
  const compat = ch.normalize("NFKC");
  if (compat !== ch && [...compat].every((c) => WIN_ANSI.has(c.codePointAt(0) ?? 0))) return compat;
  // e.g. "ő" -> "o": drop combining marks WinAnsi can't draw.
  return [...ch.normalize("NFD")].filter((c) => WIN_ANSI.has(c.codePointAt(0) ?? 0)).join("");
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** [1, 2, 3, 5, 7, 8] -> "p.1–3, 5, 7–8". */
export function formatPageRanges(pages: readonly number[]): string {
  const sorted = [...new Set((Array.isArray(pages) ? pages : []).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (!sorted.length) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of [...sorted.slice(1), Number.NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = n;
  }
  return `p.${parts.join(", ")}`;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
const fmtNum = (n: unknown) => count(n).toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** The non-null items of an array, or [] for anything that isn't one. */
function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((v) => v !== null && v !== undefined) as T[]) : [];
}

type Outcome = ReportPlace["outcome"];

/** Anything that isn't explicitly "visible" counts as redacted: the safe reading of bad data. */
const outcomeOf = (p: ReportPlace): Outcome => (p?.outcome === "visible" ? "visible" : "redacted");

/** "System" for the system actor, the sanitized name otherwise. */
function actorName(actor: unknown): string {
  const s = sanitizeText(actor);
  return s.toLowerCase() === "system" ? "System" : s || "—";
}

/** Keeps the last `n` characters, marking the cut with an ellipsis. */
const clipStart = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(-n).trimStart()}`);
/** Keeps the first `n` characters, marking the cut with an ellipsis. */
const clipEnd = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`);

/** Places grouped by document (first-seen order), each with its pages. */
function placesByDocument(places: ReportPlace[]): { document: string; pages: number[] }[] {
  const docs = new Map<string, number[]>();
  for (const p of places) {
    const name = sanitizeText(p?.document) || "(unknown document)";
    if (!docs.has(name)) docs.set(name, []);
    docs.get(name)!.push(count(p?.page));
  }
  return [...docs].map(([document, pages]) => ({ document, pages }));
}

/** "01-charging-document.pdf p.1–3", or just the name when no page number is usable. */
const docPages = (d: { document: unknown; pages: unknown }) =>
  [sanitizeText(d?.document) || "(unnamed)", formatPageRanges(list<number>(d?.pages))].filter(Boolean).join(" ");

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stateOf(c: ReportCandidate): CandidateState {
  return c.state === "kept" || c.state === "redacted" ? c.state : "flagged";
}

function typeColumn(type: unknown): string {
  const t = text(type);
  return TYPE_LABEL[t]?.column ?? (t ? t[0].toUpperCase() + t.slice(1) : "—");
}

type TimeFormatter = ReturnType<typeof timeFormatter>;

/** "Oct 30, 2026 2:14 PM" in one time zone; falls back to the server's zone if the name is invalid. */
function timeFormatter(timeZone?: string) {
  let zone: string | undefined = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = undefined;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
  const parts = (d: Date) => Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
  return {
    zone: fmt.resolvedOptions().timeZone,
    dateTime(value: unknown, opts: { zone?: boolean; seconds?: boolean } = {}): string {
      const d = toDate(value);
      if (!d) return sanitizeText(value) || "—";
      const p = parts(d);
      const clock = `${p.hour}:${p.minute}${opts.seconds ? `:${p.second}` : ""} ${p.dayPeriod}`;
      return `${p.month} ${p.day}, ${p.year} ${clock}${opts.zone && p.timeZoneName ? ` ${p.timeZoneName}` : ""}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

/** One unbreakable line of a block: knows its height and how to draw itself at a top-left corner. */
interface Line {
  height: number;
  draw(page: PDFPage, x: number, top: number, width: number): void;
}

/** A block lays itself out into lines for a given width. */
type Block = (width: number) => Line[];

interface TextStyle {
  font: PDFFont;
  size: number;
  color?: RGB;
  /** Line height as a multiple of size. */
  leading?: number;
  align?: "left" | "right";
}

/** Draws pre-sanitized text so that its line box starts at `top`. */
function drawString(page: PDFPage, s: string, x: number, top: number, lineHeight: number, style: TextStyle) {
  if (!s) return;
  const baseline = top - (lineHeight - style.size) / 2 - style.size * 0.8;
  page.drawText(s, { x, y: baseline, size: style.size, font: style.font, color: style.color ?? COLOR.text });
}

function textBlock(value: unknown, style: TextStyle): Block {
  const s = sanitizeText(value);
  const lineHeight = style.size * (style.leading ?? 1.3);
  return (width) =>
    wrapText(s, style.font, style.size, width).map((line) => ({
      height: lineHeight,
      draw(page, x, top, w) {
        const dx = style.align === "right" ? w - style.font.widthOfTextAtSize(line, style.size) : 0;
        drawString(page, line, x + dx, top, lineHeight, style);
      },
    }));
}

/** Greedy word wrap. Words wider than the line break at - _ . / when possible, otherwise anywhere. */
export function wrapText(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!s) return [];
  const width = (t: string) => font.widthOfTextAtSize(t, size);
  const lines: string[] = [];
  let current = "";
  for (const word of s.split(" ")) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = "";
    const chunks = breakToken(word, font, size, maxWidth);
    lines.push(...chunks.slice(0, -1));
    current = chunks[chunks.length - 1] ?? "";
  }
  if (current) lines.push(current);
  return lines;
}

function breakToken(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let rest = [...word];
  while (rest.length) {
    if (font.widthOfTextAtSize(rest.join(""), size) <= maxWidth) {
      chunks.push(rest.join(""));
      break;
    }
    let fit = 0;
    let used = 0;
    while (fit < rest.length) {
      const next = used + font.widthOfTextAtSize(rest[fit], size);
      if (next > maxWidth) break;
      used = next;
      fit++;
    }
    fit = Math.max(1, fit);
    // Prefer to break right after a separator if one sits in the back half of the chunk.
    for (let i = fit - 1; i >= Math.ceil(fit / 2); i--) {
      if ("-_./,;:)".includes(rest[i])) {
        fit = i + 1;
        break;
      }
    }
    chunks.push(rest.slice(0, fit).join(""));
    rest = rest.slice(fit);
  }
  return chunks;
}

function truncate(s: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  const chars = [...s];
  while (chars.length && font.widthOfTextAtSize(`${chars.join("").trimEnd()}…`, size) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

const spacer = (height: number): Block => () => [{ height, draw() {} }];

/** A run of text in one style, for `richBlock`. Runs are separated by a space unless `glue` is set. */
interface Run {
  text: unknown;
  style: TextStyle;
  /** Attach this run to the previous one with no space, e.g. a run starting with ",". */
  glue?: boolean;
}

/**
 * Word-wraps several differently styled runs as one paragraph, e.g. muted context around a bold
 * name. Runs should share a font size so their baselines line up.
 */
function richBlock(runs: Run[], lineHeight?: number): Block {
  const tokens = runs.flatMap((r) =>
    sanitizeText(r.text)
      .split(" ")
      .filter(Boolean)
      .map((word, i) => ({ word, style: r.style, glue: i === 0 && !!r.glue })),
  );
  const height = lineHeight ?? Math.max(1, ...runs.map((r) => r.style.size * (r.style.leading ?? 1.3)));
  return (width) => {
    type Segment = { text: string; style: TextStyle; x: number };
    const lines: Segment[][] = [];
    let line: Segment[] = [];
    let x = 0;
    for (const { word, style, glue } of tokens) {
      const space = line.length && !glue ? style.font.widthOfTextAtSize(" ", style.size) : 0;
      const wordWidth = style.font.widthOfTextAtSize(word, style.size);
      if (line.length && x + space + wordWidth > width) {
        lines.push(line);
        line = [];
        x = 0;
      }
      if (!line.length && wordWidth > width) {
        const chunks = breakToken(word, style.font, style.size, width);
        for (const chunk of chunks.slice(0, -1)) lines.push([{ text: chunk, style, x: 0 }]);
        const last = chunks[chunks.length - 1] ?? "";
        line = [{ text: last, style, x: 0 }];
        x = style.font.widthOfTextAtSize(last, style.size);
        continue;
      }
      const lead = line.length && !glue ? " " : "";
      const prev = line[line.length - 1];
      if (prev && prev.style === style) prev.text += lead + word;
      else line.push({ text: lead + word, style, x });
      x += (lead ? space : 0) + wordWidth;
    }
    if (line.length) lines.push(line);
    return lines.map((segments) => ({
      height,
      draw(page, left, top) {
        for (const s of segments) drawString(page, s.text, left + s.x, top, height, s.style);
      },
    }));
  };
}

/** A small uppercase label in a left gutter, with its content wrapping to the right of it. */
function labeledBlock(fonts: Fonts, label: string, content: Block[], gutter = 58): Block {
  const style: TextStyle = { font: fonts.bold, size: 6.5, color: COLOR.muted };
  const text = sanitizeText(label).toUpperCase();
  return (width) => {
    const lines = content.flatMap((block) => block(Math.max(1, width - gutter)));
    return lines.map((line, i) => ({
      height: line.height,
      draw(page, x, top, w) {
        if (i === 0) drawString(page, text, x, top, line.height, style);
        line.draw(page, x + gutter, top, w - gutter);
      },
    }));
  };
}

/** A one-line heading with an optional color swatch in front, e.g. "■ Visible (7)". */
function swatchLine(value: unknown, style: TextStyle, swatch: TagStyle | null, height = 16): Block {
  const s = sanitizeText(value);
  return (width) => [
    {
      height,
      draw(page, x, top) {
        let left = x;
        if (swatch) {
          const size = Math.round(style.size * 0.8);
          roundedRect(page, left, top - (height - size) / 2, size, size, 1.5, swatch.fill, swatch.border);
          left += size + 5;
        }
        drawString(page, truncate(s, style.font, style.size, Math.max(1, width - (left - x))), left, top, height, style);
      },
    },
  ];
}

/** A rounded rectangle; (x, top) is its top-left corner. */
function roundedRect(page: PDFPage, x: number, top: number, w: number, h: number, r: number, fill: RGB, border?: RGB) {
  const k = Math.min(r, w / 2, h / 2);
  const path = `M ${k} 0 H ${w - k} Q ${w} 0 ${w} ${k} V ${h - k} Q ${w} ${h} ${w - k} ${h} H ${k} Q 0 ${h} 0 ${h - k} V ${k} Q 0 0 ${k} 0 Z`;
  page.drawSvgPath(path, { x, y: top, color: fill, borderColor: border, borderWidth: border ? 0.5 : 0 });
}

const PILL = { size: 7, height: 12, padX: 5 };

function tagWidth(fonts: Fonts, label: string) {
  return fonts.bold.widthOfTextAtSize(label, PILL.size) + PILL.padX * 2;
}

/** A small rounded label; `label` must already be sanitized. */
function drawTag(page: PDFPage, fonts: Fonts, label: string, style: TagStyle, x: number, top: number) {
  const w = tagWidth(fonts, label);
  roundedRect(page, x, top, w, PILL.height, 2.5, style.fill, style.border);
  drawString(page, label, x + PILL.padX, top, PILL.height, { font: fonts.bold, size: PILL.size, color: style.text });
  return w;
}

function pillWidth(fonts: Fonts, state: CandidateState) {
  return tagWidth(fonts, STATE_LABEL[state]);
}

function drawPill(page: PDFPage, fonts: Fonts, state: CandidateState, x: number, top: number) {
  return drawTag(page, fonts, STATE_LABEL[state], STATE_STYLE[state], x, top);
}

/** Owns the page list and a cursor; body content flows between BODY_TOP and BODY_BOTTOM. */
class Writer {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = BODY_TOP;

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
  ) {
    this.addPage();
  }

  addPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = BODY_TOP;
  }

  get room() {
    return this.y - BODY_BOTTOM;
  }

  get atTop() {
    return this.y >= BODY_TOP;
  }

  /** Starts a new page unless `height` fits (or we're already at the top of one). */
  ensure(height: number) {
    if (height > this.room && !this.atTop) this.addPage();
  }

  /** Vertical gap that never carries over to the top of a fresh page. */
  gap(height: number) {
    if (!this.atTop) this.y = Math.max(BODY_BOTTOM, this.y - height);
  }

  flow(block: Block, x = MARGIN_X, width = CONTENT_W) {
    for (const line of block(width)) {
      this.ensure(line.height);
      line.draw(this.page, x, this.y, width);
      this.y -= line.height;
    }
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

interface Table {
  columns: Column[];
  rows: Block[][][];
  /** Shown above the repeated header row on continuation pages, e.g. "You kept, continued". */
  caption?: string;
  showHeader?: boolean;
  padX?: number;
  padY?: number;
  /** Left edge; defaults to the page margin. */
  x?: number;
}

const HEADER_ROW_H = 17;
const CAPTION_H = 15;

function layoutRow(row: Block[][], columns: Column[], padX: number): Line[][] {
  return columns.map((col, i) => (row[i] ?? []).flatMap((block) => block(Math.max(1, col.width - padX * 2))));
}

const cellHeight = (lines: Line[]) => lines.reduce((sum, l) => sum + l.height, 0);

function tableRowHeight(table: Table, row: Block[][]) {
  const padY = table.padY ?? 4;
  return Math.max(0, ...layoutRow(row, table.columns, table.padX ?? 4).map(cellHeight)) + padY * 2;
}

/** Height of the column-header row (plus the caption on continuation pages). */
function tableHeadHeight(table: Table, continued: boolean) {
  return (table.showHeader === false ? 0 : HEADER_ROW_H) + (continued && table.caption ? CAPTION_H : 0);
}

/**
 * Draws a table that paginates: the header row repeats on every page (with a "continued" caption),
 * rows move whole to the next page when they fit there, and rows taller than a page split by line.
 */
function drawTable(w: Writer, table: Table) {
  const { columns } = table;
  const padX = table.padX ?? 4;
  const padY = table.padY ?? 4;
  const left = table.x ?? MARGIN_X;
  const tableWidth = columns.reduce((s, c) => s + c.width, 0);
  const { fonts } = w;

  const drawHead = (continued: boolean) => {
    if (continued && table.caption) {
      // Shorten the name, never the ", continued".
      const suffix = ", continued";
      const room = Math.max(1, tableWidth - fonts.italic.widthOfTextAtSize(suffix, 8));
      const caption = `${truncate(sanitizeText(table.caption), fonts.italic, 8, room)}${suffix}`;
      drawString(w.page, caption, left, w.y, CAPTION_H - 3, { font: fonts.italic, size: 8, color: COLOR.muted });
      w.y -= CAPTION_H;
    }
    if (table.showHeader === false) return;
    w.page.drawRectangle({ x: left, y: w.y - HEADER_ROW_H, width: tableWidth, height: HEADER_ROW_H, color: COLOR.wash });
    w.page.drawLine({ start: { x: left, y: w.y - HEADER_ROW_H }, end: { x: left + tableWidth, y: w.y - HEADER_ROW_H }, thickness: 0.75, color: COLOR.rule });
    let x = left;
    for (const col of columns) {
      const label = sanitizeText(col.header).toUpperCase();
      const style: TextStyle = { font: fonts.bold, size: 6.75, color: COLOR.muted };
      const dx = col.align === "right" ? col.width - padX * 2 - fonts.bold.widthOfTextAtSize(label, style.size) : 0;
      drawString(w.page, label, x + padX + dx, w.y, HEADER_ROW_H, style);
      x += col.width;
    }
    w.y -= HEADER_ROW_H;
  };

  const drawSlice = (cells: Line[][], height: number) => {
    let x = left;
    cells.forEach((lines, i) => {
      let top = w.y - padY;
      for (const line of lines) {
        line.draw(w.page, x + padX, top, columns[i].width - padX * 2);
        top -= line.height;
      }
      x += columns[i].width;
    });
    w.y -= height;
    w.page.drawLine({ start: { x: left, y: w.y }, end: { x: left + tableWidth, y: w.y }, thickness: 0.5, color: COLOR.line });
  };

  const newPage = () => {
    w.addPage();
    drawHead(true);
  };

  // Never leave the header row stranded at the bottom of a page without a row under it.
  const firstRow = table.rows[0] ? Math.min(tableRowHeight(table, table.rows[0]), 40) : 0;
  w.ensure(tableHeadHeight(table, false) + firstRow);
  drawHead(false);
  const freshCapacity = BODY_TOP - BODY_BOTTOM - tableHeadHeight(table, true);

  for (const row of table.rows) {
    let rest = layoutRow(row, columns, padX);
    let fresh = false;
    while (rest.some((lines) => lines.length)) {
      const height = Math.max(...rest.map(cellHeight)) + padY * 2;
      if (height <= w.room) {
        drawSlice(rest, height);
        break;
      }
      // Move the whole row to the next page if it fits there; split it only when it's taller than a page.
      if (!fresh && (height <= freshCapacity || w.room < 48)) {
        newPage();
        fresh = true;
        continue;
      }
      const available = w.room - padY * 2;
      const take = rest.map((lines) => {
        let used = 0;
        let n = 0;
        while (n < lines.length && used + lines[n].height <= available) used += lines[n++].height;
        return fresh && n === 0 && lines.length ? 1 : n;
      });
      if (take.every((n) => n === 0)) {
        newPage();
        fresh = true;
        continue;
      }
      const slice = rest.map((lines, i) => lines.slice(0, take[i]));
      drawSlice(slice, Math.max(...slice.map(cellHeight)) + padY * 2);
      rest = rest.map((lines, i) => lines.slice(take[i]));
      if (rest.some((lines) => lines.length)) {
        newPage();
        fresh = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

function drawTitle(w: Writer, data: ReportData, batchName: string, time: TimeFormatter) {
  const { fonts } = w;
  const docs = Array.isArray(data?.batch?.documents) ? data.batch.documents.filter(Boolean) : [];
  const pages = docs.reduce((sum, d) => sum + count(d?.pages), 0);
  w.flow(textBlock("REDACTION REPORT", { font: fonts.bold, size: 7.5, color: COLOR.muted, leading: 1.6 }));
  w.flow(textBlock(batchName, { font: fonts.bold, size: 18, color: COLOR.ink, leading: 1.2 }));
  w.y -= 2;
  const created = toDate(data?.batch?.createdAt) ? `Batch created ${time.dateTime(data.batch.createdAt)} · ` : "";
  w.flow(textBlock(`${created}${plural(docs.length, "document")}, ${plural(pages, "page")}`, { font: fonts.regular, size: 9, color: COLOR.muted }));
  w.gap(14);
}

function drawSummary(w: Writer, data: ReportData, time: TimeFormatter) {
  const { fonts } = w;
  const t = data?.totals ?? ({} as Partial<ReportData["totals"]>);
  const label = (s: string): Block[] => [textBlock(s, { font: fonts.bold, size: 8, color: COLOR.muted })];
  const value = (s: string, extra: Block[] = []): Block[] => [textBlock(s, { font: fonts.regular, size: 9.5, color: COLOR.text }), ...extra];
  const note = (s: string): Block => textBlock(s, { font: fonts.regular, size: 7.5, color: COLOR.muted });

  const docs = Array.isArray(data?.batch?.documents) ? data.batch.documents.filter(Boolean) : [];
  const docLines: Block[] = docs.length
    ? docs.map((d) => documentLine(fonts, d.filename, count(d.pages)))
    : [textBlock("None", { font: fonts.regular, size: 9.5, color: COLOR.muted })];

  const byType: Record<string, number> = t.byType ?? {};
  const typeParts = Object.entries(TYPE_LABEL).map(([k, l]) => plural(count(byType[k]), l.one, l.many));

  const mentions = count(t.mentions);
  const redactedMentions = count(t.mentionsRedacted);
  const visible = Math.max(0, mentions - redactedMentions);

  const decisions: Block = () => STATE_ORDER.map((state) => decisionLine(fonts, state, count(t[state])));

  const mixed = list<ReportCandidate>(data?.candidates).filter((c) => placeSplit(c).mixed).length;
  const unassigned = list<ReportPlace>(data?.unassigned).length;
  const mentionNotes = [
    visible ? note(`${plural(visible, "mention")} will stay visible.`) : null,
    mixed ? note(`${plural(mixed, "entity is", "entities are")} visible in some places and redacted in others.`) : null,
    unassigned ? note(`${plural(unassigned, "place isn’t", "places aren’t")} tied to an entity.`) : null,
  ].filter((b): b is Block => b !== null);

  const rows: Block[][][] = [
    [label("Generated"), value(`${time.dateTime(data?.generatedAt, { zone: true })} by ${sanitizeText(data?.generatedBy) || "unknown"}`, [note(`All times in this report are ${time.zone}.`)])],
    [label("Documents"), docLines],
    [label("Candidates"), value(`${fmtNum(t.candidates)} total: ${typeParts.join(" · ")}`)],
    [label("Decisions"), [decisions]],
    [label("Mentions"), value(`${fmtNum(redactedMentions)} of ${fmtNum(mentions)} mentions redacted`, mentionNotes)],
  ];

  w.page.drawLine({ start: { x: MARGIN_X, y: w.y }, end: { x: MARGIN_X + CONTENT_W, y: w.y }, thickness: 0.75, color: COLOR.rule });
  drawTable(w, { columns: [{ header: "", width: 92 }, { header: "", width: CONTENT_W - 92 }], rows, showHeader: false, padX: 0, padY: 6, caption: "Summary" });
  w.gap(12);

  // The default-redaction note, in a quiet callout box.
  const noteText =
    "Everything the system finds is redacted by default. Items marked “System flagged” were not individually reviewed.";
  const lines = textBlock(noteText, { font: fonts.regular, size: 8.5, color: COLOR.text })(CONTENT_W - 24);
  const height = cellHeight(lines) + 14;
  w.ensure(height);
  w.page.drawRectangle({ x: MARGIN_X, y: w.y - height, width: CONTENT_W, height, color: COLOR.wash });
  w.page.drawRectangle({ x: MARGIN_X, y: w.y - height, width: 2, height, color: COLOR.muted });
  let top = w.y - 7;
  for (const line of lines) {
    line.draw(w.page, MARGIN_X + 14, top, CONTENT_W - 24);
    top -= line.height;
  }
  w.y -= height;
}

/** "01-charging-document.pdf ........ 3 pages", the filename wrapping inside its own column. */
function documentLine(fonts: Fonts, filename: unknown, pages: number): Block {
  const nameStyle: TextStyle = { font: fonts.regular, size: 9.5, color: COLOR.text };
  const pageStyle: TextStyle = { font: fonts.regular, size: 9, color: COLOR.muted, align: "right" };
  const pagesText = plural(pages, "page");
  return (width) => {
    const pagesWidth = 56;
    const nameWidth = Math.min(300, width - pagesWidth);
    const names = textBlock(sanitizeText(filename) || "(unnamed)", nameStyle)(nameWidth);
    const pagesLine = textBlock(pagesText, pageStyle)(pagesWidth)[0];
    return names.map((line, i) => ({
      height: line.height,
      draw(page, x, top) {
        line.draw(page, x, top, nameWidth);
        if (i === 0) pagesLine.draw(page, x + nameWidth, top, pagesWidth);
      },
    }));
  };
}

const DECISION_NOTE: Record<CandidateState, string> = {
  kept: "left visible by a reviewer",
  redacted: "redacted by a reviewer",
  flagged: "redacted by default, not individually reviewed",
};

/** [pill] count  explanation, with pills and counts aligned across the three lines. */
function decisionLine(fonts: Fonts, state: CandidateState, n: number): Line {
  const pillColumn = Math.max(...(["kept", "redacted", "flagged"] as const).map((s) => pillWidth(fonts, s)));
  const numStyle: TextStyle = { font: fonts.bold, size: 9.5, color: COLOR.ink, align: "right" };
  const noteStyle: TextStyle = { font: fonts.regular, size: 8.5, color: COLOR.muted };
  const height = 17;
  return {
    height,
    draw(page, x, top, width) {
      drawPill(page, fonts, state, x, top - (height - PILL.height) / 2);
      const numText = fmtNum(n);
      const numRight = x + pillColumn + 34;
      drawString(page, numText, numRight - fonts.bold.widthOfTextAtSize(numText, numStyle.size), top, height, numStyle);
      const noteX = numRight + 8;
      drawString(page, truncate(DECISION_NOTE[state], noteStyle.font, noteStyle.size, x + width - noteX), noteX, top, height, noteStyle);
    },
  };
}

/** Section title with a state swatch, a right-aligned tally, a rule, and a one-line description. */
function sectionHeading(w: Writer, title: string, tally: string, description: string, swatch: CandidateState | null, keepWith: number) {
  const { fonts } = w;
  const titleSize = 13;
  const titleH = 20;
  const descLines = textBlock(description, { font: fonts.regular, size: 8.5, color: COLOR.muted })(CONTENT_W);
  const height = titleH + 6 + cellHeight(descLines) + 6;
  w.gap(22);
  w.ensure(height + keepWith);
  const { page } = w;

  let x = MARGIN_X;
  if (swatch) {
    const s = STATE_STYLE[swatch];
    roundedRect(page, x, w.y - (titleH - 9) / 2 - 0.5, 9, 9, 2, s.fill, s.border);
    x += 15;
  }
  const titleText = truncate(sanitizeText(title), fonts.bold, titleSize, CONTENT_W - (x - MARGIN_X) - 120);
  drawString(page, titleText, x, w.y, titleH, { font: fonts.bold, size: titleSize, color: COLOR.ink });
  const tallyText = sanitizeText(tally);
  const tallySize = 8.5;
  drawString(page, tallyText, MARGIN_X + CONTENT_W - fonts.regular.widthOfTextAtSize(tallyText, tallySize), w.y, titleH, {
    font: fonts.regular,
    size: tallySize,
    color: COLOR.muted,
  });
  w.y -= titleH + 2;
  page.drawLine({ start: { x: MARGIN_X, y: w.y }, end: { x: MARGIN_X + CONTENT_W, y: w.y }, thickness: 0.75, color: COLOR.ink });
  w.y -= 5;
  for (const line of descLines) {
    line.draw(page, MARGIN_X, w.y, CONTENT_W);
    w.y -= line.height;
  }
  w.y -= 7;
}

const CANDIDATE_COLUMNS: Column[] = [
  { header: "Type", width: 58 },
  { header: "Name", width: 118 },
  { header: "Mentions", width: 72 },
  { header: "Where", width: 166 },
  { header: "Decided", width: 90 },
];

function candidateRow(fonts: Fonts, c: ReportCandidate, time: TimeFormatter): Block[][] {
  const cell: TextStyle = { font: fonts.regular, size: 8.5, color: COLOR.text };
  const small: TextStyle = { font: fonts.regular, size: 7.5, color: COLOR.muted };
  const state = stateOf(c);

  const name: Block[] = [textBlock(sanitizeText(c.label) || "(no label)", { ...cell, font: fonts.bold })];
  if (sanitizeText(c.role)) name.push(spacer(1), textBlock(c.role, small));

  const mentions = count(c.mentions);
  const exceptions = count(c.exceptions);
  // "27 (27 redacted)" on one line, or "1,204" over "(1,198 redacted)" when that doesn't fit.
  const total = `${fmtNum(mentions)} (${fmtNum(c.mentionsRedacted)} redacted)`;
  const mentionText: Block = (width) =>
    cell.font.widthOfTextAtSize(total, cell.size) <= width
      ? textBlock(total, cell)(width)
      : [...textBlock(fmtNum(mentions), cell)(width), ...textBlock(`(${fmtNum(c.mentionsRedacted)} redacted)`, cell)(width)];
  const mentionCell: Block[] = [mentionText];
  const split = placeSplit(c);
  if (split.mixed) mentionCell.push(textBlock("· Mixed outcome", { ...small, font: fonts.bold, color: COLOR.warn }));
  if (exceptions > 0) mentionCell.push(textBlock(`· ${exceptions} set individually`, { ...small, color: COLOR.warn }));

  // A mixed candidate lists where it stays visible and where it's redacted, so the exception stands out.
  const locations = list<ReportCandidate["locations"][number]>(c.locations);
  const whereStyle: TextStyle = { ...cell, size: 8 };
  const group = (title: string, color: RGB, places: ReportPlace[]): Block[] => [
    textBlock(title, { ...small, font: fonts.bold, color }),
    ...placesByDocument(places).map((d) => textBlock(docPages(d), whereStyle)),
  ];
  const where: Block[] = split.mixed
    ? [...group(`Visible (${fmtNum(split.visible.length)}):`, COLOR.visible, split.visible), spacer(2), ...group(`Redacted (${fmtNum(split.redacted.length)}):`, COLOR.ink, split.redacted)]
    : locations.length
      ? locations.map((loc) => textBlock(docPages(loc), whereStyle))
      : [textBlock("—", { ...cell, color: COLOR.muted })];

  const decided: Block[] =
    state === "flagged"
      ? [textBlock("—", { ...cell, color: COLOR.muted })]
      : [textBlock(sanitizeText(c.decidedBy) || "Unknown reviewer", cell), textBlock(toDate(c.decidedAt) ? time.dateTime(c.decidedAt) : "", small)];

  return [[textBlock(typeColumn(c.type), cell)], name, mentionCell, where, decided];
}

function drawCandidateSection(w: Writer, state: CandidateState, rows: ReportCandidate[], time: TimeFormatter) {
  const { title, description } = SECTION[state];
  const mentions = rows.reduce((sum, c) => sum + count(c.mentions), 0);
  const tally = rows.length ? `${plural(rows.length, "candidate")} · ${plural(mentions, "mention")}` : "";
  const table: Table = {
    columns: CANDIDATE_COLUMNS,
    rows: rows.map((c) => candidateRow(w.fonts, c, time)),
    caption: title,
  };
  const firstRow = table.rows[0] ? Math.min(tableRowHeight(table, table.rows[0]), 60) : 16;
  sectionHeading(w, title, tally, description, state, rows.length ? tableHeadHeight(table, false) + firstRow : 16);
  if (!rows.length) {
    w.flow(textBlock("None.", { font: w.fonts.regular, size: 9, color: COLOR.muted }));
    return;
  }
  drawTable(w, table);
}

// ---------------------------------------------------------------------------
// Entity histories: each entity's story and every place it appears
// ---------------------------------------------------------------------------

/** Entity bodies sit a little in from their name, so each entity reads as one unit. */
const INDENT = 12;
const BODY_X = MARGIN_X + INDENT;
const BODY_W = CONTENT_W - INDENT;

/** A candidate's places, split by outcome. Mixed when some are visible and some redacted. */
function placeSplit(c: ReportCandidate) {
  const places = list<ReportPlace>(c?.places);
  const visible = places.filter((p) => outcomeOf(p) === "visible");
  const redacted = places.filter((p) => outcomeOf(p) === "redacted");
  return { places, visible, redacted, mixed: visible.length > 0 && redacted.length > 0 };
}

const fixedLines =
  (lines: Line[]): Block =>
  () =>
    lines;

const linesHeight = (lines: Line[]) => lines.reduce((sum, l) => sum + l.height, 0);

function styles(fonts: Fonts) {
  const cell: TextStyle = { font: fonts.regular, size: 7.75, color: COLOR.text, leading: 1.28 };
  return {
    cell,
    muted: { ...cell, color: COLOR.muted },
    strong: { ...cell, font: fonts.bold, color: COLOR.ink },
    small: { font: fonts.regular, size: 7, color: COLOR.muted, leading: 1.28 } as TextStyle,
    meta: { font: fonts.regular, size: 8, color: COLOR.muted, leading: 1.35 } as TextStyle,
    label: { font: fonts.bold, size: 6.5, color: COLOR.muted, leading: 2 } as TextStyle,
  };
}

/** An entity's name as a caption prefix, short enough to leave room for ": visible places, continued". */
const captionName = (fonts: Fonts, name: string) => truncate(name, fonts.italic, 8, 300);

/** Name (wrapping) with a tag at the right of its first line, then any lines under it. */
function entityHeading(fonts: Fonts, name: string, tag: { text: string; style: TagStyle }, below: Block[]): Block {
  const nameStyle: TextStyle = { font: fonts.bold, size: 10.5, color: COLOR.ink, leading: 1.3 };
  return (width) => {
    const tw = tagWidth(fonts, tag.text);
    const names = textBlock(name, nameStyle)(Math.max(40, width - tw - 12));
    const lines: Line[] = names.map((line, i) =>
      i > 0
        ? line
        : {
            height: line.height,
            draw(page, x, top, w) {
              line.draw(page, x, top, w);
              drawTag(page, fonts, tag.text, tag.style, x + w - tw, top - (line.height - PILL.height) / 2);
            },
          },
    );
    return [...lines, ...below.flatMap((block) => block(width))];
  };
}

/** A thin rule between entities (not above the first one in a group), keeping `keepWith` together below it. */
function entitySeparator(w: Writer, first: boolean, keepWith: number) {
  w.gap(first ? 2 : 10);
  w.ensure(keepWith + (first ? 0 : 6));
  if (first) return;
  w.page.drawLine({ start: { x: MARGIN_X, y: w.y }, end: { x: MARGIN_X + CONTENT_W, y: w.y }, thickness: 0.5, color: COLOR.line });
  w.y -= 6;
}

/** A small uppercase label above a part of an entity ("HISTORY", "WHERE IT APPEARS"). */
function subLabel(w: Writer, text: string, keepWith: number) {
  const block = textBlock(text.toUpperCase(), styles(w.fonts).label);
  w.ensure(linesHeight(block(BODY_W)) + keepWith);
  w.flow(block, BODY_X, BODY_W);
}

function historyTable(fonts: Fonts, events: ReportEvent[], caption: string, time: TimeFormatter, x = BODY_X, width = BODY_W): Table {
  const { cell, muted } = styles(fonts);
  return {
    columns: [
      { header: "When", width: 104 },
      { header: "Who", width: 74 },
      { header: "What", width: width - 178 },
    ],
    rows: events.map((e) => [
      [textBlock(time.dateTime(e?.at, { seconds: true }), muted)],
      [textBlock(actorName(e?.actor), cell)],
      [textBlock(sanitizeText(e?.summary) || sanitizeText(e?.action) || "—", cell)],
    ]),
    caption,
    padY: 3,
    x,
  };
}

/** "…the State calls **Marcus Whitfield** to the stand…", clipped so a runaway context can't take over the row. */
function contextBlock(fonts: Fonts, p: ReportPlace): Block {
  const { muted, strong } = styles(fonts);
  const before = clipStart(sanitizeText(p?.before), 90);
  const after = clipEnd(sanitizeText(p?.after), 90);
  return richBlock([
    { text: before, style: muted },
    // No space after an opening bracket or quote, or before closing punctuation: "(Whitfield)", "Whitfield:".
    { text: clipEnd(sanitizeText(p?.text), 160) || "(no text)", style: strong, glue: /[([{‘“'"]$/.test(before) },
    { text: after, style: muted, glue: /^[,.;:!?)\]}’”'"]/.test(after) },
  ]);
}

/** Short words for what happened to one place, by audit action. Anything else shows its summary. */
const PLACE_ACTION: Record<string, string> = {
  "mention.redact": "redacted it individually",
  "mention.keep": "kept it visible individually",
  "mention.clear": "cleared its individual decision",
  "mention.carried": "re-run kept its individual decision",
  "mention.confirm": "confirmed which entity it is",
};

function placeRow(fonts: Fonts, p: ReportPlace, time: TimeFormatter, showOutcome: boolean): Block[][] {
  const { cell, small } = styles(fonts);
  const outcome = outcomeOf(p);
  const reason = sanitizeText(p?.reason);
  const why: Block[] = [];
  if (showOutcome) {
    why.push(textBlock(outcome === "visible" ? "Visible" : "Redacted", { ...cell, font: fonts.bold, color: outcome === "visible" ? COLOR.visible : COLOR.ink }));
  }
  // With no reason on record, the outcome line (or a plain one) says it all.
  if (reason || !showOutcome) why.push(textBlock(reason || (outcome === "visible" ? "Left visible" : "Redacted"), cell));

  const individually = p?.individually && typeof p.individually === "object" ? p.individually : null;
  if (individually) {
    const by = sanitizeText(individually.by);
    const parts = [by && !reason.includes(by) ? `by ${by}` : "", toDate(individually.at) ? time.dateTime(individually.at) : ""].filter(Boolean);
    if (parts.length) why.push(textBlock(parts.join(" · "), small));
  }
  const assignedBy = sanitizeText(p?.assignedBy);
  if (assignedBy) {
    why.push(textBlock(`Matched to this entity by ${assignedBy}${toDate(p.assignedAt) ? ` · ${time.dateTime(p.assignedAt)}` : ""}`, small));
  }
  // Its own story, one short line per event, only when there's more to it than the one decision above.
  const history = list<ReportEvent>(p?.history);
  if (history.length > 1) {
    why.push(spacer(2), textBlock("This place’s history:", { ...small, font: fonts.bold }));
    for (const e of history) {
      const action = text(e?.action);
      const what = Object.hasOwn(PLACE_ACTION, action) ? PLACE_ACTION[action] : sanitizeText(e?.summary) || "—";
      why.push(textBlock(`${time.dateTime(e?.at)} · ${actorName(e?.actor)}: ${what}`, small));
    }
  }

  const page = count(p?.page);
  return [
    [textBlock(sanitizeText(p?.document) || "(unknown document)", cell)],
    [textBlock(Number.isInteger(page) && page > 0 ? fmtNum(page) : "—", cell)],
    [contextBlock(fonts, p)],
    why,
  ];
}

function placesTable(fonts: Fonts, places: ReportPlace[], caption: string, time: TimeFormatter, opts: { showOutcome: boolean; x?: number; width?: number }): Table {
  const width = opts.width ?? BODY_W;
  const doc = Math.round(width * 0.24);
  const page = 30;
  const why = Math.round(width * 0.3);
  return {
    columns: [
      { header: "Document", width: doc },
      { header: "Page", width: page },
      { header: "Text in context", width: width - doc - page - why },
      { header: opts.showOutcome ? "Outcome and why" : "Why", width: why },
    ],
    rows: places.map((p) => placeRow(fonts, p, time, opts.showOutcome)),
    caption,
    padY: 3,
    x: opts.x ?? BODY_X,
  };
}

/** Header room plus the first row (capped), so a label is never left alone at the bottom of a page. */
function tableStart(table: Table) {
  return tableHeadHeight(table, false) + (table.rows[0] ? Math.min(tableRowHeight(table, table.rows[0]), 40) : 0);
}

/** "All 42 redacted", "All 3 visible", "1 place, redacted", or the mixed split. */
function placeTally(split: ReturnType<typeof placeSplit>): string {
  const n = split.places.length;
  if (split.mixed) return `Mixed: ${fmtNum(split.visible.length)} visible, ${fmtNum(split.redacted.length)} redacted`;
  const outcome = split.visible.length ? "visible" : "redacted";
  return n === 1 ? `1 place, ${outcome}` : `All ${fmtNum(n)} ${outcome}`;
}

/** Tally line, then each document with its pages. Falls back to `locations` when places are missing. */
function whereLines(fonts: Fonts, c: ReportCandidate, split: ReturnType<typeof placeSplit>): Block[] {
  const { cell, strong, muted } = styles(fonts);
  if (split.places.length) {
    return [
      textBlock(placeTally(split), { ...strong, color: split.visible.length ? COLOR.visible : COLOR.ink }),
      ...placesByDocument(split.places).map((d) => textBlock(docPages(d), cell)),
    ];
  }
  const locations = list<ReportCandidate["locations"][number]>(c?.locations);
  if (!locations.length) return [textBlock("No places recorded.", muted)];
  return [textBlock(plural(count(c?.mentions), "mention"), strong), ...locations.map((loc) => textBlock(docPages(loc), cell))];
}

function drawEntity(w: Writer, c: ReportCandidate, first: boolean, time: TimeFormatter) {
  const { fonts } = w;
  const st = styles(fonts);
  const state = stateOf(c);
  const name = sanitizeText(c.label) || "(no label)";
  const split = placeSplit(c);
  const history = list<ReportEvent>(c.history);

  // Places worth a row even when the entity isn't mixed: decided one by one, or not following the entity.
  const expected: Outcome = state === "kept" ? "visible" : "redacted";
  const noted = split.mixed ? [] : split.places.filter((p) => outcomeOf(p) !== expected || (p?.individually && typeof p.individually === "object"));
  // A short, uneventful story (a system flag, maybe one decision) gets lines instead of a table, so a
  // long batch stays readable. Mixed entities and anything with exceptions always get the full form.
  const compact = !split.mixed && !noted.length && history.length <= 3;

  const createdBy = sanitizeText(c.createdBy);
  const meta = [
    typeColumn(c.type),
    sanitizeText(c.role),
    createdBy && createdBy.toLowerCase() !== "ai" ? `added by ${createdBy}` : "",
    state === "flagged" ? "redacted by default, not reviewed" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const below: Block[] = [textBlock(meta, st.meta)];
  if (state !== "flagged") {
    const who = sanitizeText(c.decidedBy) || "an unknown reviewer";
    const decided: TextStyle = { ...st.meta, font: fonts.bold, color: state === "kept" ? COLOR.visible : COLOR.ink };
    below.push(
      richBlock([
        { text: "Latest:", style: { ...st.meta, color: COLOR.text } },
        { text: state === "kept" ? `kept (left visible) by ${who}` : `redacted by ${who}`, style: decided },
        { text: toDate(c.decidedAt) ? `· ${time.dateTime(c.decidedAt)}` : "", style: st.meta },
      ]),
    );
  }
  const heading = entityHeading(fonts, name, { text: STATE_LABEL[state], style: STATE_STYLE[state] }, below)(CONTENT_W);
  const headingHeight = linesHeight(heading);

  if (compact) {
    const events: Block[] = history.length
      ? history.map((e) =>
          richBlock([
            { text: time.dateTime(e?.at, { seconds: true }), style: st.muted },
            { text: `· ${actorName(e?.actor)} ·`, style: st.muted },
            { text: sanitizeText(e?.summary) || sanitizeText(e?.action) || "—", style: st.cell },
          ]),
        )
      : [textBlock("No recorded events.", st.muted)];
    const body = [
      ...spacer(3)(BODY_W),
      ...labeledBlock(fonts, "History", events)(BODY_W),
      ...spacer(2)(BODY_W),
      ...labeledBlock(fonts, "Where", whereLines(fonts, c, split))(BODY_W),
    ];
    const total = headingHeight + linesHeight(body);
    entitySeparator(w, first, total <= 200 ? total : headingHeight + 30);
    w.flow(fixedLines(heading));
    w.flow(fixedLines(body), BODY_X, BODY_W);
    return;
  }

  const histTable = history.length ? historyTable(fonts, history, `${captionName(fonts, name)}: history`, time) : null;
  entitySeparator(w, first, headingHeight + 16 + (histTable ? tableStart(histTable) : 12));
  w.flow(fixedLines(heading));
  w.y -= 4;

  subLabel(w, "History", histTable ? tableStart(histTable) : 12);
  if (histTable) drawTable(w, histTable);
  else w.flow(textBlock("No recorded events.", st.muted), BODY_X, BODY_W);

  w.gap(8);
  if (split.mixed) {
    subLabel(w, "Where it appears", 40);
    w.flow(textBlock(`${placeTally(split)}. Every place is listed under its outcome.`, { ...st.strong, color: COLOR.warn }), BODY_X, BODY_W);
    for (const outcome of ["visible", "redacted"] as const) {
      const places = outcome === "visible" ? split.visible : split.redacted;
      const table = placesTable(fonts, places, `${captionName(fonts, name)}: ${outcome} places`, time, { showOutcome: false });
      const title = swatchLine(`${outcome === "visible" ? "Visible" : "Redacted"} (${fmtNum(places.length)})`, { font: fonts.bold, size: 8.5, color: COLOR.ink }, OUTCOME_STYLE[outcome], 18);
      w.gap(4);
      w.ensure(18 + tableStart(table));
      w.flow(title, BODY_X, BODY_W);
      drawTable(w, table);
    }
    return;
  }

  const where = whereLines(fonts, c, split);
  subLabel(w, "Where it appears", Math.min(40, linesHeight(where.flatMap((b) => b(BODY_W)))));
  for (const block of where) w.flow(block, BODY_X, BODY_W);
  if (noted.length) {
    const table = placesTable(fonts, noted, `${captionName(fonts, name)}: exceptions`, time, { showOutcome: true });
    const title = swatchLine(`Decided individually or not following the entity (${fmtNum(noted.length)})`, { font: fonts.bold, size: 8.5, color: COLOR.ink }, null, 18);
    w.gap(6);
    w.ensure(18 + tableStart(table));
    w.flow(title, BODY_X, BODY_W);
    drawTable(w, table);
  }
}

/** A group within the entity histories ("You kept · 12 entities"), with a swatch and a rule. */
function groupHeading(w: Writer, state: CandidateState, n: number, keepWith: number, first: boolean) {
  const { fonts } = w;
  const height = 18;
  w.gap(first ? 2 : 18);
  w.ensure(height + 6 + keepWith);
  const s = STATE_STYLE[state];
  roundedRect(w.page, MARGIN_X, w.y - (height - 8) / 2, 8, 8, 2, s.fill, s.border);
  const title = sanitizeText(SECTION[state].title);
  drawString(w.page, title, MARGIN_X + 13, w.y, height, { font: fonts.bold, size: 10, color: COLOR.ink });
  const tally = plural(n, "entity", "entities");
  const tallySize = 8;
  drawString(w.page, tally, MARGIN_X + CONTENT_W - fonts.regular.widthOfTextAtSize(tally, tallySize), w.y, height, { font: fonts.regular, size: tallySize, color: COLOR.muted });
  w.y -= height;
  w.page.drawLine({ start: { x: MARGIN_X, y: w.y }, end: { x: MARGIN_X + CONTENT_W, y: w.y }, thickness: 0.75, color: COLOR.rule });
  w.y -= 6;
}

function drawEntityHistories(w: Writer, groups: { state: CandidateState; rows: ReportCandidate[] }[], time: TimeFormatter) {
  const total = groups.reduce((sum, g) => sum + g.rows.length, 0);
  // With no entities the three sections above already say "None."; nothing to add.
  if (!total) return;
  sectionHeading(
    w,
    "Entity histories",
    plural(total, "entity", "entities"),
    "Each entity in the same order as above: where it stands now, everything that happened to it (oldest first), and every place it appears. When some places are visible and others redacted, every place is listed under its outcome.",
    null,
    90,
  );
  let first = true;
  for (const { state, rows } of groups) {
    if (!rows.length) continue;
    groupHeading(w, state, rows.length, 60, first);
    first = false;
    rows.forEach((c, i) => drawEntity(w, c, i === 0, time));
  }
}

function drawRetired(w: Writer, retired: ReportRetired[], time: TimeFormatter) {
  const { fonts } = w;
  const st = styles(fonts);
  sectionHeading(
    w,
    "No longer in the results",
    plural(retired.length, "entity", "entities"),
    "A merge or a re-run of detection removed these after a person had worked on them. Their history stays on record.",
    null,
    90,
  );
  retired.forEach((r, i) => {
    const name = sanitizeText(r?.label) || "(unknown)";
    const meta = [r?.type ? typeColumn(r.type) : "", sanitizeText(r?.reason)].filter(Boolean).join(" · ");
    const heading = entityHeading(fonts, name, { text: "Removed", style: STATE_STYLE.flagged }, [textBlock(meta, st.meta)])(CONTENT_W);
    const history = list<ReportEvent>(r?.history);
    const table = history.length ? historyTable(fonts, history, `${captionName(fonts, name)}: history`, time) : null;
    entitySeparator(w, i === 0, linesHeight(heading) + 16 + (table ? tableStart(table) : 12));
    w.flow(fixedLines(heading));
    w.y -= 4;
    subLabel(w, "History", table ? tableStart(table) : 12);
    if (table) drawTable(w, table);
    else w.flow(textBlock("No recorded events.", st.muted), BODY_X, BODY_W);
  });
}

function drawUnassigned(w: Writer, places: ReportPlace[], time: TimeFormatter) {
  const visible = places.filter((p) => outcomeOf(p) === "visible").length;
  const table = placesTable(w.fonts, places, "Not tied to an entity", time, { showOutcome: true, x: MARGIN_X, width: CONTENT_W });
  sectionHeading(
    w,
    "Not tied to an entity",
    `${plural(places.length, "place")}${visible ? ` · ${fmtNum(visible)} visible` : ""}`,
    "Places the system found that aren’t tied to any entity. They’re redacted to be safe unless a person kept them.",
    null,
    tableStart(table),
  );
  drawTable(w, table);
}

function drawAuditTrail(w: Writer, events: ReportData["events"], time: TimeFormatter) {
  const { fonts } = w;
  const cell: TextStyle = { font: fonts.regular, size: 8, color: COLOR.text, leading: 1.25 };
  const table: Table = {
    columns: [
      { header: "When", width: 106 },
      { header: "Actor", width: 82 },
      { header: "Event", width: CONTENT_W - 188 },
    ],
    rows: events.map((e) => [
      [textBlock(time.dateTime(e.at, { seconds: true }), { ...cell, color: COLOR.muted })],
      [textBlock(sanitizeText(e.actor) || "—", cell)],
      [textBlock(sanitizeText(e.summary) || "—", cell)],
    ]),
    caption: "Audit trail",
    padY: 3,
  };
  const firstRow = table.rows[0] ? Math.min(tableRowHeight(table, table.rows[0]), 40) : 16;
  sectionHeading(
    w,
    "Audit trail",
    events.length ? `${plural(events.length, "event")}, oldest first` : "",
    "Every action on this batch, in the order it happened.",
    null,
    events.length ? tableHeadHeight(table, false) + firstRow : 16,
  );
  if (!events.length) {
    w.flow(textBlock("No events recorded.", { font: fonts.regular, size: 9, color: COLOR.muted }));
    return;
  }
  drawTable(w, table);
}

/** Running header (title + INTERNAL notice) and footer (generated date + page X of Y) on every page. */
function drawChrome(w: Writer, batchName: string, generated: string) {
  const { fonts, pages } = w;
  const notice = "INTERNAL — contains the redacted information. Do not share with the redacted documents.";
  const footerStyle: TextStyle = { font: fonts.regular, size: 7.5, color: COLOR.muted };
  pages.forEach((page, i) => {
    // Header: report title, then the INTERNAL band.
    const title = truncate(sanitizeText(`Redaction report — ${batchName}`), fonts.bold, 8.5, CONTENT_W);
    drawString(page, title, MARGIN_X, PAGE_H - 34, 12, { font: fonts.bold, size: 8.5, color: COLOR.ink });

    const bandTop = PAGE_H - 50;
    const bandH = 18;
    page.drawRectangle({ x: MARGIN_X, y: bandTop - bandH, width: CONTENT_W, height: bandH, color: COLOR.internalFill });
    page.drawRectangle({ x: MARGIN_X, y: bandTop - bandH, width: 3, height: bandH, color: COLOR.internalBar });
    const noticeText = truncate(notice, fonts.bold, 7.75, CONTENT_W - 20);
    drawString(page, noticeText, MARGIN_X + 11, bandTop, bandH, { font: fonts.bold, size: 7.75, color: COLOR.internalText });

    // Footer.
    const footerTop = 50;
    page.drawLine({ start: { x: MARGIN_X, y: footerTop }, end: { x: MARGIN_X + CONTENT_W, y: footerTop }, thickness: 0.5, color: COLOR.line });
    const pageText = `Page ${i + 1} of ${pages.length}`;
    const pageWidth = fonts.regular.widthOfTextAtSize(pageText, footerStyle.size);
    drawString(page, truncate(sanitizeText(generated), fonts.regular, footerStyle.size, CONTENT_W - pageWidth - 24), MARGIN_X, footerTop - 6, 12, footerStyle);
    drawString(page, pageText, MARGIN_X + CONTENT_W - pageWidth, footerTop - 6, 12, footerStyle);
  });
}
