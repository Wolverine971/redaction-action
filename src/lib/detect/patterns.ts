/**
 * Deterministic detectors. These never call a model, so they're fast, free, and testable:
 * Social Security numbers in every common form, and case-citation spans.
 */

export interface PatternHit {
  start: number;
  end: number;
  text: string;
  /** Full 9 digits when known, otherwise the last 4. */
  digits: string;
  kind: "full" | "masked" | "last4";
  confidence: number;
  decision: "redact" | "keep";
  reason: string;
}

const SSN_CONTEXT = /\b(?:SSN|SSNs|SS#|S\.S\.N\.?|social\s+security|soc\.?\s*sec\.?|taxpayer\s+id(?:entification)?|TIN)\b/i;
// The label closest to the number decides what it is ("Customer ID (CIF): 307-41-8826" is not an SSN,
// even if "SSN" appeared earlier on the line).
const NON_SSN_CONTEXT =
  /\b(?:routing|account|acct|a\/c|invoice|inv|policy|claim|case|docket|bates|order|ref(?:erence)?|tracking|phone|tel|fax|cell|EIN|employer\s+id(?:entification)?|loan|member|patient|mrn|record|serial|badge|permit|license|item|check|cheque|confirmation|customer|client|cif|id|tax\s+id|file)\b[^\d]{0,24}$/i;
const LAST_FOUR_CONTEXT = /\b(?:last\s+(?:four|4)(?:\s+digits)?|ending\s+(?:in|with)|ends\s+(?:in|with))\b/gi;

/** SSA never issues area 000, 666 or 900–999, group 00, or serial 0000. */
export function isPlausibleSsn(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const area = Number(digits.slice(0, 3));
  const group = Number(digits.slice(3, 5));
  const serial = Number(digits.slice(5));
  return area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0;
}

function before(text: string, index: number, chars: number) {
  return text.slice(Math.max(0, index - chars), index);
}

export function findSsns(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const push = (hit: PatternHit) => {
    if (overlaps(hit.start, hit.end)) return;
    taken.push([hit.start, hit.end]);
    hits.push(hit);
  };

  // 1. Dashed: 123-45-6789. The strongest signal; SSN unless labeled as something else.
  for (const m of text.matchAll(/(?<![\w-])(\d{3})-(\d{2})-(\d{4})(?![\w-])/g)) {
    const digits = m[1] + m[2] + m[3];
    const ctx = before(text, m.index, 60);
    const near = before(text, m.index, 30);
    const labeledOther = NON_SSN_CONTEXT.test(near) && !SSN_CONTEXT.test(near);
    const plausible = isPlausibleSsn(digits);
    push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      digits,
      kind: "full",
      confidence: labeledOther ? 0.35 : SSN_CONTEXT.test(ctx) ? 0.98 : plausible ? 0.85 : 0.6,
      decision: labeledOther ? "keep" : "redact",
      reason: labeledOther
        ? "SSN-shaped, but labeled as another kind of number"
        : SSN_CONTEXT.test(ctx)
          ? "SSN format next to an SSN label"
          : "SSN format (123-45-6789)",
    });
  }

  // 2. Masked: XXX-XX-6789, ***-**-6789. The last four are still identifying.
  for (const m of text.matchAll(/(?<![\w*•#])[Xx*•#]{3}[- ]?[Xx*•#]{2}[- ]?(\d{4})(?!\d)/g)) {
    push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      digits: m[1],
      kind: "masked",
      confidence: 0.95,
      decision: "redact",
      reason: "Masked SSN; the last four digits are still identifying",
    });
  }

  // 3. Spaced (123 45 6789) or bare (123456789): only with an SSN label nearby.
  for (const m of text.matchAll(/(?<![\w-])(\d{3})([ ]?)(\d{2})\2(\d{4})(?![\w-])/g)) {
    const digits = m[1] + m[3] + m[4];
    const ctx = before(text, m.index, 60);
    const near = before(text, m.index, 30);
    if (!SSN_CONTEXT.test(ctx) || (NON_SSN_CONTEXT.test(near) && !SSN_CONTEXT.test(near))) continue;
    push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      digits,
      kind: "full",
      confidence: isPlausibleSsn(digits) ? 0.95 : 0.7,
      decision: "redact",
      reason: "9-digit number next to an SSN label",
    });
  }

  // 4. Last four in prose: "SSN ending in 6789", "last four digits of her Social Security number are 6789".
  // The 4 digits must be the first number after the "last four" phrase, and not part of a date or amount.
  for (const m of text.matchAll(/(?<![\w\/.,:$-])(\d{4})(?![\w\/.,:-]\d|[\w-])/g)) {
    const window = text.slice(Math.max(0, m.index - 90), m.index);
    const phrases = [...window.matchAll(LAST_FOUR_CONTEXT)];
    const last = phrases[phrases.length - 1];
    if (!last || !SSN_CONTEXT.test(window)) continue;
    const gap = window.slice(last.index + last[0].length);
    if (/\d/.test(gap.replace(/\b4\b/, ""))) continue;
    push({
      start: m.index,
      end: m.index + 4,
      text: m[0],
      digits: m[1],
      kind: "last4",
      confidence: 0.9,
      decision: "redact",
      reason: "Last four digits of an SSN",
    });
  }

  return hits.sort((a, b) => a.start - b.start);
}

const CONNECTORS = new Set(["of", "the", "and", "&", "ex", "rel.", "in", "re", "for", "de", "la", "van", "von", "et", "al.", "al"]);
// Citation signal words that precede a case name but aren't part of it.
const SIGNALS = new Set(["see", "cf.", "accord", "compare", "but", "also", "e.g.,", "under", "in", "citing", "quoting", "and"]);

/**
 * Spans that look like case names: "Smith v. Jones", "State of Maryland v. John Smith".
 * Returns the span of the parties (capitalized words on each side of "v.").
 */
export function findCaseCitations(text: string): { start: number; end: number; text: string }[] {
  const spans: { start: number; end: number; text: string }[] = [];
  // Short-form cites: "Smith, 512 U.S. at 224".
  for (const m of text.matchAll(/(?<![\p{L}])[A-Z][\p{L}'’-]+,\s+\d+\s+[A-Z][\p{L}.\d ]{0,12}?\s+at\s+\d+/gu)) {
    spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  for (const m of text.matchAll(/\s(v\.|vs\.)\s/g)) {
    const vStart = m.index + 1;
    const vEnd = m.index + m[0].length - 1;
    const startIdx = walk(text, vStart, -1);
    const endIdx = walk(text, vEnd, 1);
    if (startIdx < vStart && endIdx > vEnd) spans.push({ start: startIdx, end: endIdx, text: text.slice(startIdx, endIdx) });
  }
  return spans;
}

function walk(text: string, from: number, dir: 1 | -1): number {
  let edge = from;
  let pos = from;
  for (let words = 0; words < 6; words++) {
    // skip whitespace
    let p = pos;
    while (dir === -1 ? p > 0 && /\s/.test(text[p - 1]) : p < text.length && /\s/.test(text[p])) p += dir;
    // read a word
    let q = p;
    while (dir === -1 ? q > 0 && !/\s/.test(text[q - 1]) : q < text.length && !/\s/.test(text[q])) q += dir;
    const word = dir === -1 ? text.slice(q, p) : text.slice(p, q);
    if (!word) break;
    const bare = word.replace(/^[("'“]+|[)"'”,;:]+$/g, "");
    const isName = /^[A-Z][\w.'’&-]*$/.test(bare) && !SIGNALS.has(bare.toLowerCase());
    if (!isName && !CONNECTORS.has(bare.toLowerCase())) break;
    // A word ending a sentence on the left ("...testified. Smith v. Jones") is not part of the case name.
    if (dir === -1 && words > 0 && /[.!?]$/.test(word) && !/^[A-Z]\.$/.test(word)) break;
    if (isName) {
      // Trim trailing punctuation (a comma after "Jones," is not part of the name).
      // Trim trailing punctuation, including a sentence-ending period (but not an initial like "J.").
      const trimmedLen = word.replace(/[,;:)]+$/, "").replace(/(\w{2,})\.$/, "$1").length;
      edge = dir === -1 ? q : p + trimmedLen;
    }
    pos = q;
    // A comma after a word on the right-hand side ends the case name ("Jones, 512 U.S. 218").
    if (dir === 1 && /,$/.test(word)) break;
  }
  return edge;
}
