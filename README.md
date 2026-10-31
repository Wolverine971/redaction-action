# Redaction Action

Upload a batch of related PDFs. The app finds every name, home address, and Social Security number, groups them by person across all the files, and gives a reviewer a fast way to approve what gets blacked out. The export permanently removes the text, not just covers it, and checks its own work.

## The flow

1. **Upload** one or more PDFs as a batch (one legal matter). Or click **Load sample case** to use the 10-document synthetic corpus.
2. **Detection** runs in the background, in stages:
   1. **Index.** Each PDF is read into pages and paragraphs, with a box for every character (MuPDF). Every finding points to an exact place: document → page → paragraph → characters.
   2. **Patterns.** SSNs in every form: `212-45-6789`, `212 45 6789`, bare 9 digits next to an SSN label, masked `XXX-XX-6789`, and "SSN ending in 6789". This step needs no AI and costs nothing. Partial SSNs are linked back to the full number.
   3. **Cast.** One AI call reads the whole batch and lists who and what is in it: people with their roles, addresses, SSN owners, and organizations, plus every spelling of each name.
   4. **Scan.** The AI reads a few pages at a time with the cast in hand and reports every mention, attributed in context ("Mr. Smith" in Steve's deposition is Steve).
   5. **Sweep.** Plain text search for every spelling of every name and address on every page. The AI decides *who*; code finds *every place*, so a mention on page 87 can't slip through. Single words that are also ordinary English ("Will", "May") are left to the AI, which reads context.
   6. **Shared names.** A mention that fits more than one person ("Mr. Smith", "Smith") gets an AI guess and goes to the reviewer's **Who is this?** queue. Until a reviewer confirms it, it is redacted to be safe.
3. **Review** on one screen: a list grouped by People / Addresses / SSNs / Organizations on the left, and the page with highlight boxes on the right.
4. **Export** a zip containing:
   - the redacted PDFs
   - a redaction log (page, category, and box position; never the redacted text, so it's safe to send along)
   - a verification report

## How it handles the assignment's key challenges

| Challenge | What the app does |
| --- | --- |
| **False positives** | SSN-shaped numbers labeled as account, routing, or case numbers are flagged *keep*. Common-word names aren't searched alone. Surnames inside citations to other cases ("Smith v. Jones") are an AI exception set to *keep*. Judges, attorneys, and organizations are listed but suggested *keep*. |
| **False negatives** | Three detectors back each other up: patterns, AI, and the exhaustive sweep. Reviewers can **Find text** (`/`) to search the batch and redact every match of a missed spelling in one step, or add a spelling to a person ("Johnny"). |
| **Volume** | Decisions are made per *person*, not per mention. "John Smith" covers all 42 of his mentions across 8 files. Shared-name mentions are grouped ("Mr. Smith × 80 → Steve Smith, 93%: Confirm all"). There's keyboard review (`↑ ↓ r k u n p`), plus bulk "accept AI suggestions" per tab. |
| **Multiple files** | A batch shares one list of people, so a decision about John applies in every document. The page viewer steps through a person's mentions across files ("Mention 3 of 42"). |
| **Context** | Every mention can be an exception to its person's decision. The AI suggests these (the citation case) and reviewers can set them. The **Needs a look** tab collects all of them. |
| **Audit trail** | Every decision, assignment, merge, and export is recorded with the reviewer's name and time. The log is append-only and downloadable as CSV. |

### Decision rules

These are the same rules for the screen and the export, in `src/lib/decisions.ts`:

1. A reviewer's per-mention override wins.
2. An unconfirmed shared-name mention is redacted if *any* person it might be is redacted.
3. An AI exception (e.g. a citation) applies until a reviewer overrides it.
4. Otherwise the mention follows its person: the reviewer's decision, or the AI suggestion while pending.

### Export safety

MuPDF removes the text, images, and vector art under each box. Then we re-open the output and check that no character's center falls inside any redaction box. If one does, the export fails and nothing is downloaded. PDF metadata (title, author) is cleared too.

## Catch-rate score

`eval/corpus/` holds a synthetic case (*State v. John Smith*) with an answer key. It includes three Smiths, a minor known as "E.S.", a witness named May (next to dates in May), a coworker named Will (next to the verb "will"), case citations, and SSN-shaped decoy numbers. `pnpm eval` runs detection and grades the AI's suggestions *before any human review*:

- what share of PII is fully redacted
- how many traps get wrongly redacted
- how often shared names are attributed to the right person
- how many decisions a reviewer needs to clear the batch

The corpus: 10 PDFs, 46 pages, 380 things to redact, and 516 planted traps. The traps include 147 SSN-like numbers, 105 uses of "May" or "Will" that aren't names, 13 case citations, 91 officials, and 134 organizations. See [`eval/corpus/README.md`](eval/corpus/README.md).

| Run | Caught | Traps wrongly redacted | Shared names attributed right |
| --- | --- | --- | --- |
| SSN patterns only (no AI) | 18/380 (all 18 SSNs and partial SSNs) | 0/516 | — |
| Full pipeline | *pending: needs `OPENROUTER_API_KEY`* | | |

```bash
pnpm eval                  # full pipeline (needs OPENROUTER_API_KEY)
pnpm eval --model google/gemini-3.8-flash   # same corpus, any OpenRouter model
pnpm eval --patterns-only  # baseline with no AI
pnpm eval --fresh          # ignore cached model answers
pnpm corpus                # regenerate and verify the corpus
```

## Getting started

Requires Node 24+, pnpm, and Postgres 16 (a local install or Docker).

```bash
pnpm install
cp .env.example .env.local      # set DATABASE_URL and OPENROUTER_API_KEY
createdb redaction_action       # or: docker compose up -d
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000. Without `OPENROUTER_API_KEY` the app still runs, but finds only SSNs; a banner says so.

AI calls go through [OpenRouter](https://openrouter.ai), so any model works, including free ones. `REDACTION_MODEL` sets the default (`nvidia/nemotron-3.5-super-vl:free`, chosen by the catch-rate score below). `REDACTION_MODEL_CAST`, `REDACTION_MODEL_SCAN`, and `REDACTION_MODEL_RESOLVE` override it per stage; for example, use a cheaper model for the page-by-page scan. `REDACTION_EFFORT` (default `medium`) sets reasoning effort. Models with strict structured output get the JSON schema enforced; models without it get the schema in the prompt, and every answer is validated either way. Free models run 4 calls at a time (`REDACTION_CONCURRENCY`) to stay under their rate limits.

> **Privacy:** free OpenRouter endpoints may log prompts. That's fine for the synthetic sample case. For real client documents, use a paid model on a provider with zero data retention.

## Scripts

| Command            | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `pnpm dev`         | Start the dev server                             |
| `pnpm build`       | Production build                                 |
| `pnpm lint`        | ESLint                                           |
| `pnpm typecheck`   | Generate route types and run `tsc`               |
| `pnpm test`        | Run Vitest once (uses the database in `.env.local`; the AI is faked) |
| `pnpm eval`        | Catch-rate score on the synthetic corpus         |
| `pnpm corpus`      | Regenerate and verify the synthetic corpus       |
| `pnpm db:generate` | Create a migration from changes to `src/db/schema.ts` |
| `pnpm db:migrate`  | Apply pending migrations                         |
| `pnpm db:studio`   | Open Drizzle Studio to browse the database       |

## Layout

```
src/lib/pdf/            Read PDFs into paragraphs + character boxes, render pages, burn in redactions
src/lib/detect/         Patterns, name variants and sweep, OpenRouter calls, the detection pipeline
src/lib/decisions.ts    How a mention ends up redacted or kept (shared by UI and export)
src/lib/process.ts      Runs detection for a batch and saves results
src/lib/review.ts       Review data, reviewer actions + audit log, search, export
src/components/review/  The review screen
src/app/api/            Upload, actions, search, page images, export, audit CSV
scripts/eval.mts        Catch-rate score
eval/corpus/            Synthetic documents + answer key
```

## Not in this version

- Scanned PDFs (would need OCR); the app says so if a PDF has no text.
- Real accounts. The reviewer's name is a cookie; the audit log trusts it.
- Phone numbers, emails, dates of birth, and account numbers aren't redaction categories yet. The policy text in `src/lib/detect/llm.ts` and the entity types are the places to extend.
