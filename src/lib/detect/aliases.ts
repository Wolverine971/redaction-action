/**
 * Name variants and text search. The model tells us *who* is in the documents;
 * this code finds *every place* they appear, so a mention on page 87 can't slip through.
 */

const HONORIFICS = ["Mr.", "Mrs.", "Ms.", "Miss", "Dr."];
const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "esq", "esq."]);

/**
 * Single words that are also ordinary English (or months). Searching for these alone
 * would flag "will" or "May 3" — so we leave them to the model, which reads context.
 */
export const COMMON_WORDS = new Set(
  `will may june april august march grace hope faith joy rose lily ivy iris ruby pearl holly amber dawn summer autumn
  mark grant bill frank art gene guy pat ray rich rob rod sandy chase chance chip dean drew earl gil hunter jack lane
  lee mason miles pierce reed rusty sol stone ted ward wade young brown white black green gray grey king cook baker
  carter cash hall hill long love wood woods page price rice sharp short stern strong small little noble major moody
  booker bush wells fields banks waters may's will's an a i al ed`.split(/\s+/),
);

/** Words that describe someone's role, not who they are. "Defendant" is not a name to search for. */
const ROLE_WORDS = new Set(
  `the a an his her their my our defendant defendants plaintiff plaintiffs petitioner respondent appellant appellee witness
  deponent victim complainant affiant declarant claimant applicant patient employee employer minor child children
  mother father son daughter wife husband grandfather grandmother granddaughter grandson parent guardian neighbor
  client customer subject suspect accused officer detective judge court counsel attorney mr mrs ms miss dr sir madam
  director manager supervisor president vice chief head assistant associate senior clerk custodian administrator
  human resources compliance operations security department of and for &`.split(/\s+/),
);

/** Can this alias safely be searched for on its own across the whole batch? */
export function isSearchableAlias(alias: string): boolean {
  const trimmed = alias.trim();
  if (trimmed.length < 2 || isCommonWord(trimmed)) return false;
  if (!/[A-Z0-9]/.test(trimmed)) return false;
  const words = trimmed.toLowerCase().replace(/[.,'’&]/g, " ").split(/\s+/).filter(Boolean);
  return !words.every((w) => ROLE_WORDS.has(w) || w === "s");
}

export function isCommonWord(alias: string): boolean {
  const words = alias.trim().split(/\s+/);
  return words.length === 1 && COMMON_WORDS.has(words[0].toLowerCase().replace(/[.,]$/, ""));
}

/** Common spellings of a person's name, generated from the label the model gave us. */
export function personVariants(label: string): string[] {
  const tokens = label
    .replace(/["“”]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !HONORIFICS.includes(t));
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1].toLowerCase().replace(/,$/, ""))) tokens.pop();
  if (tokens.length === 0) return [];
  const clean = (t: string) => t.replace(/[,]$/, "");
  const first = clean(tokens[0]);
  const last = clean(tokens[tokens.length - 1]);
  const variants = new Set<string>([tokens.map(clean).join(" ")]);
  if (tokens.length >= 2) {
    variants.add(`${first} ${last}`);
    variants.add(`${first[0]}. ${last}`);
    variants.add(`${last}, ${first}`);
    for (const h of HONORIFICS) variants.add(`${h} ${last}`);
    variants.add(last);
    if (first.length > 1 && !first.endsWith(".")) variants.add(first);
  }
  return [...variants];
}

/** "1418 Elm Street, Baltimore, MD 21201" → also "1418 Elm Street" and "1418 Elm St." */
export function addressVariants(label: string): string[] {
  const variants = new Set<string>([label.trim()]);
  const street = label.split(",")[0].trim();
  if (/^\d+\s+\S+/.test(street)) {
    variants.add(street);
    // "Elm Street" alone (as in "the Elm Street house") still points at the home.
    const name = street.replace(/^\d+[A-Za-z]?\s+/, "").replace(/\s+(?:apt|apartment|unit|suite|#).*$/i, "");
    if (name.split(/\s+/).length >= 2) variants.add(name);
  }
  const abbreviations: [RegExp, string][] = [
    [/\bStreet\b/i, "St."],
    [/\bAvenue\b/i, "Ave."],
    [/\bRoad\b/i, "Rd."],
    [/\bBoulevard\b/i, "Blvd."],
    [/\bDrive\b/i, "Dr."],
    [/\bLane\b/i, "Ln."],
    [/\bCourt\b/i, "Ct."],
    [/\bApartment\b/i, "Apt."],
  ];
  for (const v of [...variants]) {
    for (const [long, short] of abbreviations) {
      if (long.test(v)) variants.add(v.replace(long, short));
    }
  }
  return [...variants];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regex for an alias. Multi-word aliases match case-insensitively across line breaks.
 * Single words must be capitalized (Smith, SMITH) so we don't match ordinary words.
 * A period after an abbreviation is optional ("St" / "St.").
 */
export function aliasPattern(alias: string): RegExp | null {
  const words = alias.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const body = words
    .map((w) => escape(w).replace(/\\\.$/, "\\.?"))
    .join("[\\s\\u00a0]+");
  const bounded = `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`;
  if (words.length === 1 && !/[\d.]/.test(words[0])) {
    const w = words[0];
    const capitalized = escape(w[0].toUpperCase() + w.slice(1));
    const upper = escape(w.toUpperCase());
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${capitalized}|${upper})(?![\\p{L}\\p{N}])`, "gu");
  }
  return new RegExp(bounded, "giu");
}

export interface TextMatch {
  start: number;
  end: number;
  text: string;
  alias: string;
}

export type CompiledAliases = [alias: string, pattern: RegExp][];

export function compileAliases(aliases: string[]): CompiledAliases {
  return aliases.flatMap((a) => {
    const re = aliasPattern(a);
    return re ? [[a, re] as [string, RegExp]] : [];
  });
}

/** Every non-overlapping match of any alias, longest match winning where they overlap. */
export function findAliases(text: string, aliases: string[] | CompiledAliases): TextMatch[] {
  const compiled = typeof aliases[0] === "string" ? compileAliases(aliases as string[]) : (aliases as CompiledAliases);
  const all: TextMatch[] = [];
  for (const [alias, re] of compiled) {
    for (const m of text.matchAll(re)) {
      all.push({ start: m.index, end: m.index + m[0].length, text: m[0], alias });
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: TextMatch[] = [];
  for (const m of all) {
    if (kept.some((k) => m.start < k.end && m.end > k.start)) continue;
    kept.push(m);
  }
  return kept;
}

/** Lowercased, punctuation-light key used to decide whether two aliases are "the same text". */
export function aliasKey(alias: string): string {
  return alias
    .toLowerCase()
    .replace(/[’']s$/, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Key used to merge entities the model named slightly differently ("John A. Smith" vs "John Smith"). */
export function personKey(label: string): string {
  const tokens = label
    .toLowerCase()
    .replace(/[.,"“”]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !["mr", "mrs", "ms", "miss", "dr", "jr", "sr", "ii", "iii", "iv", "esq"].includes(t));
  if (tokens.length <= 1) return tokens.join(" ");
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

/** Extends a name span over a possessive: "Chen" in "Ms. Chen's" becomes "Chen's". */
export function withPossessive(text: string, end: number): number {
  return /^['’][sS](?![\p{L}\p{N}])/u.test(text.slice(end, end + 3)) ? end + 2 : end;
}

/** Extends a name span back over an honorific: "Smith" in "Mr. Smith" becomes "Mr. Smith". */
export function withHonorific(text: string, start: number): number {
  const m = text.slice(Math.max(0, start - 6), start).match(/(?<![\p{L}])(?:Mr|Mrs|Ms|Dr|MR|MRS|MS|DR)\.?\s+$|(?<![\p{L}])(?:Miss|MISS)\s+$/u);
  return m ? start - m[0].length : start;
}

const NOT_A_PERSON_AFTER = /^(?:\s*&|-[A-Z0-9]|\s+(?:Avenue|Ave\.?|Street|St\.|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Way|Place|Pl\.|Square|Building|Hall|Center|Park|Bridge|County|College|University|Act|Rule)\b)/;

/**
 * A lone surname that's part of something else: "Smith & Wesson", "Smith Avenue", Bates number "SMITH-DEF-000014".
 */
export function isPartOfOtherName(text: string, start: number, end: number): boolean {
  if (/[-/]$/.test(text.slice(Math.max(0, start - 1), start))) return true;
  return NOT_A_PERSON_AFTER.test(text.slice(end, end + 14));
}

const MONTH_LEAD = /(?:^|\s)(?:in|of|on|since|until|till|by|early|late|mid|during|through|from|last|next|this|before|after|between|and|or)\s+$/i;
const MONTHS = new Set(["may", "june", "april", "august", "march"]);
const MODALS = new Set(["will", "may"]);
/** Words that follow "Will"/"May" when they're verbs: "Will you…", "May I…", "May the record reflect…". */
const FOLLOWS_MODAL = new Set(
  "i you we he she they it the this that these those there counsel your our my his her their a an be not also please each everyone anyone anybody someone somebody any all".split(" "),
);
/** Words that follow a name starting a sentence: "Price stated…", "Will was…". */
const NAME_VERBS = new Set(
  `was is had has did does said says stated testified told asked answered explained described recalled reported
  identified wanted called saw heard fell went came left arrived returned worked lived knew thought believed
  would could should might never always also then later and`.split(/\s+/),
);

/**
 * A capitalized common word ("Will", "May", "Price") counts as a name only where it can't be the ordinary word:
 * mid-sentence (not "Will you…" / "May I…"), not a date ("May 3"), and not after a month preposition ("in May").
 */
export function isNameInContext(text: string, start: number, end: number): boolean {
  const word = text.slice(start, end);
  if (!/^[A-Z][a-z]/.test(word)) return false;
  const before = text.slice(Math.max(0, start - 24), start);
  // After an honorific it's a name ("Mr. Price").
  if (/(?:^|\s)(?:Mr|Mrs|Ms|Dr)\.\s+$/.test(before)) return true;
  const after = text.slice(end, end + 16);
  if (/^\s*\d/.test(after)) return false;
  // At a sentence or line start (including transcript markers "Q." / "A."), capitalization proves nothing.
  // Decide by the next word: "Will you…" / "May I…" are verbs; "Will was…" / "Price stated…" are names.
  // (A line break alone isn't a sentence start: paragraphs wrap mid-sentence.)
  const sentenceStart = /(?:^|[.!?:;"“]\s*|(?:^|\s)[QA]\.\s+)$/.test(before) || before.trim() === "";
  if (sentenceStart) {
    const next = after.match(/^\s+([A-Za-z']+)/)?.[1]?.toLowerCase() ?? "";
    if (MODALS.has(word.toLowerCase())) return !!next && !FOLLOWS_MODAL.has(next);
    return NAME_VERBS.has(next);
  }
  if (MONTHS.has(word.toLowerCase()) && MONTH_LEAD.test(before)) return false;
  return true;
}
