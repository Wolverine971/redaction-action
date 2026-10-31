import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { STATE_LABEL, type CandidateState, type ReportCandidate, type ReportData } from "@/lib/report-types";

/**
 * Renders the internal "Redaction report" for a batch: what the system flagged, what a reviewer
 * redacted or kept (and who decided when), and the full audit trail. US Letter, portrait.
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
  const candidates = (Array.isArray(data?.candidates) ? data.candidates : []).filter(Boolean);
  const byState = (state: CandidateState) => candidates.filter((c) => stateOf(c) === state);

  drawTitle(w, data, batchName, time);
  drawSummary(w, data, time);
  for (const state of ["kept", "redacted", "flagged"] as const) drawCandidateSection(w, state, byState(state), time);
  drawAuditTrail(w, Array.isArray(data?.events) ? data.events.filter(Boolean) : [], time);

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
  internalFill: hex("#fbeeee"),
  internalBar: hex("#b42318"),
  internalText: hex("#7a1a12"),
};

const STATE_STYLE: Record<CandidateState, { fill: RGB; text: RGB; border?: RGB }> = {
  flagged: { fill: hex("#e5e5e5"), text: hex("#404040"), border: hex("#cfcfcf") },
  redacted: { fill: COLOR.ink, text: COLOR.white },
  kept: { fill: hex("#059669"), text: COLOR.white },
};

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

/** A rounded rectangle; (x, top) is its top-left corner. */
function roundedRect(page: PDFPage, x: number, top: number, w: number, h: number, r: number, fill: RGB, border?: RGB) {
  const k = Math.min(r, w / 2, h / 2);
  const path = `M ${k} 0 H ${w - k} Q ${w} 0 ${w} ${k} V ${h - k} Q ${w} ${h} ${w - k} ${h} H ${k} Q 0 ${h} 0 ${h - k} V ${k} Q 0 0 ${k} 0 Z`;
  page.drawSvgPath(path, { x, y: top, color: fill, borderColor: border, borderWidth: border ? 0.5 : 0 });
}

const PILL = { size: 7, height: 12, padX: 5 };

function pillWidth(fonts: Fonts, state: CandidateState) {
  return fonts.bold.widthOfTextAtSize(STATE_LABEL[state], PILL.size) + PILL.padX * 2;
}

function drawPill(page: PDFPage, fonts: Fonts, state: CandidateState, x: number, top: number) {
  const style = STATE_STYLE[state];
  const w = pillWidth(fonts, state);
  roundedRect(page, x, top, w, PILL.height, 2.5, style.fill, style.border);
  drawString(page, STATE_LABEL[state], x + PILL.padX, top, PILL.height, { font: fonts.bold, size: PILL.size, color: style.text });
  return w;
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
  const tableWidth = columns.reduce((s, c) => s + c.width, 0);
  const { fonts } = w;

  const drawHead = (continued: boolean) => {
    if (continued && table.caption) {
      drawString(w.page, sanitizeText(`${table.caption}, continued`), MARGIN_X, w.y, CAPTION_H - 3, {
        font: fonts.italic,
        size: 8,
        color: COLOR.muted,
      });
      w.y -= CAPTION_H;
    }
    if (table.showHeader === false) return;
    w.page.drawRectangle({ x: MARGIN_X, y: w.y - HEADER_ROW_H, width: tableWidth, height: HEADER_ROW_H, color: COLOR.wash });
    w.page.drawLine({ start: { x: MARGIN_X, y: w.y - HEADER_ROW_H }, end: { x: MARGIN_X + tableWidth, y: w.y - HEADER_ROW_H }, thickness: 0.75, color: COLOR.rule });
    let x = MARGIN_X;
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
    let x = MARGIN_X;
    cells.forEach((lines, i) => {
      let top = w.y - padY;
      for (const line of lines) {
        line.draw(w.page, x + padX, top, columns[i].width - padX * 2);
        top -= line.height;
      }
      x += columns[i].width;
    });
    w.y -= height;
    w.page.drawLine({ start: { x: MARGIN_X, y: w.y }, end: { x: MARGIN_X + tableWidth, y: w.y }, thickness: 0.5, color: COLOR.line });
  };

  const newPage = () => {
    w.addPage();
    drawHead(true);
  };

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

  const decisions: Block = () =>
    (["kept", "redacted", "flagged"] as const).map((state) => decisionLine(fonts, state, count(t[state])));

  const rows: Block[][][] = [
    [label("Generated"), value(`${time.dateTime(data?.generatedAt, { zone: true })} by ${sanitizeText(data?.generatedBy) || "unknown"}`, [note(`All times in this report are ${time.zone}.`)])],
    [label("Documents"), docLines],
    [label("Candidates"), value(`${fmtNum(t.candidates)} total: ${typeParts.join(" · ")}`)],
    [label("Decisions"), [decisions]],
    [
      label("Mentions"),
      value(`${fmtNum(redactedMentions)} of ${fmtNum(mentions)} mentions redacted`, visible ? [note(`${plural(visible, "mention")} will stay visible.`)] : []),
    ],
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
  if (exceptions > 0) mentionCell.push(textBlock(`· ${exceptions} set individually`, { ...small, color: COLOR.warn }));

  const locations = (Array.isArray(c.locations) ? c.locations : []).filter(Boolean);
  const where: Block[] = locations.length
    ? locations.map((loc) => textBlock([sanitizeText(loc.document) || "(unnamed)", formatPageRanges(loc.pages)].filter(Boolean).join(" "), { ...cell, size: 8 }))
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
