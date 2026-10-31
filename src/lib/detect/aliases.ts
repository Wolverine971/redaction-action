/**
 * Name variants and text search. The model tells us *who* is in the documents;
 * this code finds *every place* they appear, so a mention on page 87 can't slip through.
 */
import { nicknamesFor } from "./nicknames";

/** Courtesy titles. Documents may use any of them for anyone, so every untitled person gets all of them. */
const HONORIFICS = ["Mr.", "Mrs.", "Ms.", "Miss", "Dr."];
/**
 * Professional titles, by family. Someone labeled with one ("Officer Kevin Chen") gets every form in the
 * family ("Ofc. Chen", "Officer K. Chen") instead of courtesy titles. That keeps an officer's "Ofc. Chen"
 * his, instead of colliding with a namesake witness's "Ms. Chen".
 */
const TITLE_FAMILIES: string[][] = [
  ["Officer", "Ofc."],
  ["Detective", "Det."],
  ["Sergeant", "Sgt."],
  ["Lieutenant", "Lt."],
  ["Captain", "Capt."],
  ["Deputy", "Dep."],
  ["Trooper", "Tpr."],
  ["Agent", "Special Agent"],
  ["Judge", "Hon.", "Justice"],
  ["Dr.", "Doctor"],
  ["Professor", "Prof."],
  ["Reverend", "Rev."],
];
const normTitle = (t: string) => t.toLowerCase().replace(/\.$/, "");
const TITLES = new Map<string, string[]>(TITLE_FAMILIES.flatMap((f) => f.map((t) => [normTitle(t), f] as const)));
TITLES.set("honorable", TITLE_FAMILIES.find((f) => f.includes("Judge"))!);
const COURTESY = new Set(["mr", "mrs", "ms", "miss", "mx"]);
const GENERATIONS = new Set(["jr", "sr", "ii", "iii", "iv"]);
const SUFFIXES = new Set([...GENERATIONS, "esq"]);
const isSuffix = (t: string) => SUFFIXES.has(t.toLowerCase().replace(/[.,]+$/, ""));

/**
 * Single words that are also ordinary English (or months). Searching for these alone
 * would flag "will" or "May 3" — so we leave them to the model, which reads context.
 */
export const COMMON_WORDS = new Set(
  `will may june april august march grace hope faith joy rose lily ivy iris ruby pearl holly amber dawn summer autumn
  mark grant bill frank art gene guy pat ray rich rob rod sandy chase chance chip dean drew earl gil hunter jack lane
  lee mason miles pierce reed rusty sol stone ted ward wade young brown white black green gray grey king cook baker
  carter cash hall hill long love wood woods page price rice sharp short stern strong small little noble major moody
  booker bush wells fields banks waters may's will's an a i al ed nick don bob dick chuck sue josh dot hank`.split(/\s+/),
);

/** Words that describe someone's role, not who they are. "Defendant" is not a name to search for. */
const ROLE_WORDS = new Set(
  `the a an his her their my our defendant defendants plaintiff plaintiffs petitioner respondent appellant appellee witness
  deponent victim complainant affiant declarant claimant applicant patient employee employer minor child children
  mother father son daughter wife husband grandfather grandmother granddaughter grandson parent guardian neighbor
  client customer subject suspect accused officer ofc detective det sergeant sgt lieutenant lt captain capt deputy dep
  trooper tpr agent special judge hon honorable justice prof professor rev reverend doctor court counsel attorney
  mr mrs ms miss mx dr sir madam director manager supervisor president vice chief head assistant associate senior
  clerk custodian administrator human resources compliance operations security department of and for &`.split(/\s+/),
);

/**
 * Initials that are usually something else: times, places, degrees, company forms ("L.P."), "S.S." for
 * Social Security. A person with these initials is still found by name, just not by initials.
 */
const INITIALS_STOPLIST = new Set(
  `AM PM US UK EU DC LA NY NJ SC NC WV RI MD DO RN NP PA JD BA BS MA MS PC LP LC PO ID TV AD BC ER IV OR PT OT AG DA
  GP HR IT PD VP SS CJ JP AC DJ OK RV SA NA TBD AKA FKA DBA LLC LLP PLLC CEO CFO COO MBA PHD DDS EMT`.split(/\s+/),
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

/**
 * A person label split into its title family (if any) and name tokens: "Officer Kevin Chen" →
 * officer family + [Kevin, Chen]; "SMITH, JOHN A." → [JOHN, A., SMITH]; suffixes ("Jr.") dropped.
 */
function parsePersonLabel(label: string): { family: string[] | null; tokens: string[] } {
  let text = label.replace(/["“”]/g, " ").trim();
  // "SMITH, JOHN A." → "JOHN A. SMITH" (but "John Smith, Jr." stays as it is).
  const inverted = text.match(/^([^,]+),\s*([^,]+)$/);
  if (inverted && !isSuffix(inverted[2].trim())) text = `${inverted[2]} ${inverted[1]}`;
  const tokens = text.split(/\s+/).filter(Boolean);
  let family: string[] | null = null;
  while (tokens.length > 1) {
    const t = normTitle(tokens[0]);
    if (t === "the" || COURTESY.has(t)) tokens.shift();
    else if (t === "special" && normTitle(tokens[1]) === "agent") tokens.splice(0, 1);
    else if (TITLES.has(t)) {
      family ??= TITLES.get(t)!;
      tokens.shift();
    } else break;
  }
  while (tokens.length > 1 && isSuffix(tokens[tokens.length - 1])) tokens.pop();
  return { family, tokens: tokens.map((t) => t.replace(/,$/, "")) };
}

/** "Emily R. Smith" → ["E.S.", "E.R.S."], skipping ones that usually mean something else ("L.P.", "M.D."). */
function initialsOf(tokens: string[]): string[] {
  const letters = tokens.map((t) => t.match(/\p{L}/u)?.[0]?.toUpperCase()).filter((c): c is string => !!c);
  if (letters.length < 2) return [];
  const forms = [[letters[0], letters[letters.length - 1]], letters];
  return [...new Set(forms.map((f) => f.join("")))].filter((s) => !INITIALS_STOPLIST.has(s)).map((s) => `${[...s].join(".")}.`);
}

/**
 * Common spellings of a person's name, generated from the label the model gave us: full name, first + last,
 * "J. Smith", "Smith, John", titles + surname, surname and first name alone, nicknames ("Steve" for Stephen),
 * and with `initials`, dotted initials ("E.S."; minors are often named that way).
 * Middle names the label leaves out ("John Andrew Smith") are matched by `personPatterns`.
 */
export function personVariants(label: string, options: { initials?: boolean; aliases?: string[] } = {}): string[] {
  const parsed = parsePersonLabel(label);
  const { tokens } = parsed;
  if (tokens.length === 0) return [];
  // The label may leave the title out ("Kevin Chen") while the aliases have it ("Officer Chen").
  const family = parsed.family ?? (options.aliases ?? []).map((a) => parsePersonLabel(a).family).find(Boolean) ?? null;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const variants = new Set<string>([tokens.join(" ")]);
  if (tokens.length >= 2) {
    const initial = `${first[0]}.`;
    variants.add(`${first} ${last}`);
    variants.add(`${initial} ${last}`);
    variants.add(`${last}, ${first}`);
    variants.add(`${last}, ${initial}`);
    if (tokens.length > 2) variants.add(`${last}, ${tokens.slice(0, -1).join(" ")}`);
    for (const h of family ?? HONORIFICS) {
      variants.add(`${h} ${last}`);
      // "Ofc. Kevin Chen", "Det. B. Kowalski": a title makes the longer forms safe to claim.
      if (family) variants.add(`${h} ${first} ${last}`).add(`${h} ${initial} ${last}`);
    }
    variants.add(last);
    if (first.length > 1 && !first.endsWith(".")) {
      variants.add(first);
      for (const nick of nicknamesFor(first)) variants.add(nick).add(`${nick} ${last}`);
    }
    if (options.initials) for (const i of initialsOf(tokens)) variants.add(i);
  }
  return [...variants];
}

/**
 * Is this model-given alias actually a form of the person's name? One word ("Johnny", "E.S.") or a phrase
 * containing part of the name ("the younger Mr. Smith"). Role phrases ("Reporting Officer", "Courtroom Clerk
 * to Judge Alvarez") aren't: searching for them would black out a job title everywhere it appears.
 */
export function isAliasOf(alias: string, label: string, otherAliases: string[] = []): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[,'’]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/\.$/, ""))
      .filter(Boolean);
  const aliasWords = words(alias);
  if (aliasWords.length <= 1) return true;
  // The name's words: from the label, plus one-word aliases (a minor labeled "E.S." is also "Emily").
  const singles = otherAliases.filter((a) => words(a).length === 1);
  const name = new Set([...personVariants(label), ...singles].flatMap(words).filter((t) => t.length > 1 && !COURTESY.has(t) && !TITLES.has(t)));
  return aliasWords.some((w) => name.has(w));
}

/**
 * Patterns for name forms with a middle name or initial the label doesn't have: "John Smith" also matches
 * "John Andrew Smith" and "JOHN A SMITH"; "Smith, John" also matches "SMITH, JOHN ANDREW" and "MARSH, WILLIAM J.".
 * Each pattern is keyed by the plain variant it extends, so matches attribute like that variant.
 */
export function personPatterns(label: string): CompiledAliases {
  const { tokens } = parsePersonLabel(label);
  if (tokens.length < 2) return [];
  const first = wordPattern(tokens[0]);
  const last = wordPattern(tokens[tokens.length - 1]);
  const gap = "[\\s\\u00a0]+";
  // One middle name or initial, capitalized even when the rest isn't ("John andrew Smith" is not a name).
  const middle = `(?-i:["“]?\\p{Lu}[\\p{L}'’-]*["”]?)\\.?`;
  const bound = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
  return [
    [`${tokens[0]} ${tokens[tokens.length - 1]}`, bound(`${first}${gap}${middle}${gap}${last}`)],
    [`${tokens[tokens.length - 1]}, ${tokens[0]}`, bound(`${last},?${gap}${first}${gap}${middle}`)],
  ];
}

/** Street-type and direction words with their abbreviations, and state names with their codes. */
const ADDRESS_WORDS: [long: string, short: string][] = [
  ["Street", "St"], ["Avenue", "Ave"], ["Road", "Rd"], ["Boulevard", "Blvd"], ["Drive", "Dr"], ["Lane", "Ln"],
  ["Court", "Ct"], ["Place", "Pl"], ["Terrace", "Ter"], ["Circle", "Cir"], ["Parkway", "Pkwy"], ["Highway", "Hwy"],
  ["Square", "Sq"], ["Trail", "Trl"], ["Apartment", "Apt"], ["Suite", "Ste"], ["Building", "Bldg"], ["Floor", "Fl"],
  ["North", "N"], ["South", "S"], ["East", "E"], ["West", "W"],
  ["Alabama", "AL"], ["Alaska", "AK"], ["Arizona", "AZ"], ["Arkansas", "AR"], ["California", "CA"], ["Colorado", "CO"],
  ["Connecticut", "CT"], ["Delaware", "DE"], ["Florida", "FL"], ["Georgia", "GA"], ["Hawaii", "HI"], ["Idaho", "ID"],
  ["Illinois", "IL"], ["Indiana", "IN"], ["Iowa", "IA"], ["Kansas", "KS"], ["Kentucky", "KY"], ["Louisiana", "LA"],
  ["Maine", "ME"], ["Maryland", "MD"], ["Massachusetts", "MA"], ["Michigan", "MI"], ["Minnesota", "MN"],
  ["Mississippi", "MS"], ["Missouri", "MO"], ["Montana", "MT"], ["Nebraska", "NE"], ["Nevada", "NV"],
  ["New Hampshire", "NH"], ["New Jersey", "NJ"], ["New Mexico", "NM"], ["New York", "NY"], ["North Carolina", "NC"],
  ["North Dakota", "ND"], ["Ohio", "OH"], ["Oklahoma", "OK"], ["Oregon", "OR"], ["Pennsylvania", "PA"],
  ["Rhode Island", "RI"], ["South Carolina", "SC"], ["South Dakota", "SD"], ["Tennessee", "TN"], ["Texas", "TX"],
  ["Utah", "UT"], ["Vermont", "VT"], ["Virginia", "VA"], ["Washington", "WA"], ["West Virginia", "WV"],
  ["Wisconsin", "WI"], ["Wyoming", "WY"], ["District of Columbia", "DC"],
];
/**
 * Word → pattern for every form of it. Single-word entries only (multi-word state names match as written).
 * A shared abbreviation matches all its words: "Ct" is Court or Connecticut, "Fl" is Floor or Florida.
 */
const ADDRESS_SWAPS = (() => {
  const forms = new Map<string, Set<string>>();
  const add = (key: string, words: string[]) => forms.set(key, new Set([...(forms.get(key) ?? []), ...words]));
  for (const [long, short] of ADDRESS_WORDS.filter(([long]) => !long.includes(" "))) {
    add(long.toLowerCase(), [long, short]);
    add(short.toLowerCase(), [long, short]);
  }
  return new Map([...forms].map(([key, words]) => [key, `(?:${[...words].join("|")})`]));
})();
const STREET_TYPES = ADDRESS_WORDS.slice(0, 16).flatMap(([l, s]) => [l, s]).join("|");

/**
 * "1418 Elm Street, Baltimore, MD 21201" → also "1418 Elm Street", "Elm Street", and "1418 Elm".
 * Abbreviations and state codes don't need variants: address aliases are compiled with `{ address: true }`,
 * which matches "Street"/"St."/"ST" and "Maryland"/"MD" interchangeably.
 */
export function addressVariants(label: string): string[] {
  const variants = new Set<string>([label.trim()]);
  const street = label.split(",")[0].trim();
  const number = street.match(/^\d+[A-Za-z]?(?=\s)/)?.[0];
  if (number) {
    variants.add(street);
    const name = street.slice(number.length).trim().replace(/\s+(?:apt|apartment|unit|suite|#).*$/i, "");
    // "Elm Street" alone (as in "the Elm Street house") still points at the home.
    if (name.split(/\s+/).length >= 2) variants.add(name);
    // "1418 Elm": the house number keeps it specific even without the street type.
    const bare = name.replace(new RegExp(`\\s+(?:${STREET_TYPES})\\.?$`, "i"), "");
    if (bare && bare !== name) variants.add(`${number} ${bare}`);
  }
  return [...variants];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Escaped word that also matches the other apostrophe and hyphen characters PDFs use ("O’Brien", "Garcia–Lopez"). */
const wordPattern = (w: string) => escape(w).replace(/[-‐‑–]/g, "[-‐‑–]").replace(/['’‘ʼ]/g, "['’‘ʼ]");

/**
 * Regex for an alias. Multi-word aliases match case-insensitively across line breaks.
 * Single words must be capitalized (Smith, SMITH) so we don't match ordinary words.
 * A period or comma after a word is optional ("St" / "St.", "Baltimore MD" / "Baltimore, MD").
 * Dotted initials ("E.S.") match only in capitals, with or without a space ("E. S.").
 * With `address`, street types, directions, and state names also match their abbreviations.
 */
export function aliasPattern(alias: string, options: { address?: boolean } = {}): RegExp | null {
  const words = alias.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const edge = (body: string, flags: string) => new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
  if (words.length === 1 && /^(?:\p{Lu}\.){2,}$/u.test(words[0])) {
    const letters = words[0].split(".").filter(Boolean);
    return edge(letters.map((l) => `${l}\\.`).join("[\\s\\u00a0]?").replace(/\\\.$/, "\\.?"), "gu");
  }
  if (words.length === 1 && !/[\d.]/.test(words[0])) {
    const w = words[0];
    const forms = new Set([w[0].toUpperCase() + w.slice(1), w[0].toUpperCase() + w.slice(1).toLowerCase(), w.toUpperCase()]);
    return edge(`(?:${[...forms].map(wordPattern).join("|")})`, "gu");
  }
  const body = words
    .map((w) => {
      const [, core, punct] = w.match(/^(.*?)([.,]*)$/)!;
      const swap = options.address ? ADDRESS_SWAPS.get(core.toLowerCase()) : undefined;
      // Addresses are written with and without commas ("Baltimore MD 21218"), so any word may carry one.
      const comma = punct.includes(",") || options.address;
      return `${swap ?? wordPattern(core)}${punct.includes(".") || swap ? "\\.?" : ""}${comma ? ",?" : ""}`;
    })
    .join("[\\s\\u00a0]+");
  return edge(body, "giu");
}

export interface TextMatch {
  start: number;
  end: number;
  text: string;
  alias: string;
}

export type CompiledAliases = [alias: string, pattern: RegExp][];

export function compileAliases(aliases: string[], options: { address?: boolean } = {}): CompiledAliases {
  return aliases.flatMap((a) => {
    const re = aliasPattern(a, options);
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
    .replace(/['’‘ʼ]/g, "'")
    .replace(/'s$/, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Key used to merge entities the model named slightly differently ("John A. Smith", "Officer John Smith",
 * "SMITH, JOHN"). A generation suffix stays in the key: "John Smith Jr." and "John Smith Sr." are two people.
 */
export function personKey(label: string): string {
  const generation = label.match(/\b(jr|sr|ii|iii|iv)\b\.?\s*$/i)?.[1]?.toLowerCase();
  const { tokens } = parsePersonLabel(label);
  const names = tokens.map((t) => t.toLowerCase().replace(/[.,]/g, "")).filter(Boolean);
  const base = names.length <= 1 ? names.join(" ") : `${names[0]} ${names[names.length - 1]}`;
  return generation ? `${base} ${generation}` : base;
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
