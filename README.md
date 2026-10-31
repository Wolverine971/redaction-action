# Redaction Action

Upload a batch of related PDFs. The app finds every name, home address, and Social Security number, groups them by person across all the files, and gives a reviewer a fast way to approve what gets blacked out. The export permanently removes the text, not just covers it, and checks its own work.

## The flow

1. **Upload** one or more PDFs as a batch (one legal matter). Or click **Load sample case** to use the 10-document synthetic corpus.
2. **Detection** runs in the background, in stages:
   1. **Index.** Each PDF is read into pages and paragraphs, with a box for every character (MuPDF). Every finding points to an exact place: document → page → paragraph → characters.
   2. **Patterns.** SSNs in every form: `212-45-6789`, `212 45 6789`, bare 9 digits next to an SSN label, masked `XXX-XX-6789`, and "SSN ending in 6789". This step needs no AI and costs nothing. Partial SSNs are linked back to the full number.
   3. **Cast.** One AI call reads the whole batch and lists who and what is in it: people with their roles, addresses, SSN owners, and organizations, plus every spelling of each name.
   4. **Scan.** The AI reads a few pages at a time with the cast in hand and reports every mention, attributed in context ("Mr. Smith" in Steve's deposition is Steve).
   5. **Sweep.** Plain text search for every spelling of every name and address on every page. The AI decides *who*; code finds *every place*, so a mention on page 87 can't slip through. It searches the spellings the AI listed plus ones generated from each name: nicknames (Steve for Stephen), dotted initials for people being redacted (`E.S.`), titles (`Ofc. Chen`, `Det. Kowalski`), middle names the AI left out (`JOHN ANDREW SMITH`, `MARSH, WILLIAM J.`), and address abbreviations in either direction (`St`/`Street`, `MD`/`Maryland`, `1418 Elm`). Single words that are also ordinary English ("Will", "May", "Price") count only where context says they're a name: mid-sentence and capitalized, not "May 3" or "Will you…".
   6. **Shared names.** A mention that fits more than one person ("Mr. Smith", "Smith") gets an AI guess about who it is. Until a reviewer confirms it, it is redacted if *any* of those people is redacted. Once a reviewer keeps one of them, the mention shows up in the **Who is this?** queue.
3. **Review** on one screen: a list grouped by People / Addresses / SSNs / Organizations on the left, and the page with highlight boxes on the right.
4. **Export** a zip with two folders:
   - `share/`: the redacted PDFs, a redaction log (page, category, and box position; never the redacted text, so it's safe to send along), and a verification report
   - `internal/`: the redaction report (PDF) with each entity's history, a decisions spreadsheet, a spreadsheet of every place each entity appears (redacted or visible, and why), and the audit trail. These name what was redacted, so they stay in the office.

## How it handles the assignment's key challenges

| Challenge | What the app does |
| --- | --- |
| **False positives** | Common-word names ("Will", "May", "Price") only match where context says they're a name. A surname that's part of something else (`Smith & Wesson`, `Smith Avenue`, Bates `SMITH-DEF-000014`) is skipped. Officials get their own titled spellings (`Ofc. Chen`), so they don't collide with a witness named Chen. The patterns and the AI also mark likely *keeps*: SSN-shaped account and routing numbers, judges, attorneys, organizations, and surnames inside citations ("Smith v. Jones"). The catch-rate score grades those calls. The review screen doesn't show them yet: everything found starts redacted until a reviewer keeps it. |
| **False negatives** | Three detectors back each other up: patterns, AI, and the exhaustive sweep. Reviewers can **Find text** (`/`) to search the batch and redact every match of a missed spelling in one step, or add a spelling to a person ("Smitty"). |
| **Volume** | Decisions are made per *person*, not per mention. "John Smith" covers all 42 of his mentions across 8 files. Shared-name mentions are grouped ("Mr. Smith × 80 → Steve Smith, 93%: Confirm all"). There's keyboard review (`↑ ↓ r k u n p`), plus redact-all and keep-all for each group. |
| **Multiple files** | A batch shares one list of people, so a decision about John applies in every document. The page viewer steps through a person's mentions across files ("Mention 3 of 42"). |
| **Context** | A reviewer can redact or keep any single mention, overriding the decision for that person. |
| **Audit trail** | Every flag, decision, assignment, merge, re-run, and export is recorded with the reviewer's name and time. Overwriting a decision keeps the old one on record. The database refuses edits and deletes to the log. The report shows each entity's history and every place it appears, redacted or visible. See [Decision history](#decision-history). |

### Decision rules

These are the same rules for the screen and the export, in `src/lib/decisions.ts`. Everything the system finds is redacted by default; only a person can keep something.

1. A reviewer's per-mention decision wins.
2. An unconfirmed shared-name mention is redacted if *any* person it might be is redacted.
3. Otherwise the mention follows its person: kept only if a reviewer chose to keep that person.

### Decision history

Every change is a row in `audit_events`, written in the same transaction as the change and stamped with the same time. Each row saves a copy of the entity's name and type, the mention's text and page, and the state before and after (`flagged`, `redacted`, `kept`, or `follows` for a mention with no exception of its own). The history still reads correctly after a merge or re-run removes the entity. A Postgres trigger rejects `UPDATE`, `DELETE`, and `TRUNCATE` on the table. Rows go away only when their whole batch is deleted.

- **Overwrites stay on record.** "Redacted person "John Smith" (was kept by Priya)". Choosing the decision something already has is a no-op, so it doesn't take credit from whoever made it.
- **Who set a mention's exception** (`decided_by`) is kept apart from **who confirmed which person it is** (`assigned_by`).
- **Merges** record the merged-away entity's decision and how many mentions flipped between visible and redacted. Its history continues under the entity it was merged into.
- **The report page** (`/batches/[id]/audit`) lists every entity with its latest status. Open one to see its history, newest first, and every place it appears. When some places are visible and others redacted, they're split into Visible and Redacted, and each place says why and who set it. The review screen shows the same history when you expand an entity.

### Re-running detection keeps reviewers' work

Re-running detection replaces the system's suggestions, not people's decisions (`src/lib/carry-over.ts`). Earlier results stay in place until the new ones are saved, so a failed re-run loses nothing.

- An entity found again keeps its id, its decision, and who made it and when. It's matched by type, then by name or a known spelling.
- A mention found at the same place keeps its id, any per-mention exception, and any confirmed assignment.
- Anything a person decided, confirmed, or added by hand stays even if the new run doesn't find it.
- A merge a person made is re-applied when the new run lists the two separately again.
- Only entities nobody reviewed can disappear. Each outcome is logged: found again, new, kept from before, no longer found, and any individual decision that couldn't be placed in the new results.

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
| Spelling search only: the answer key's names, no AI reading pages | 374/380 | 2/516 | — (nobody resolves shared names) |
| Full pipeline, `nvidia/nemotron-3.5-super-vl:free` | 375/380 (98.7%) | 1/516 | 52/54 |

The spelling-search row shows how much the sweep finds once it knows who's who, with no model reading pages. The spelling rules were tuned on this corpus, so treat that row as a regression check, not a measure of how they'd do on new documents.

```bash
pnpm eval                  # full pipeline (needs OPENROUTER_API_KEY)
pnpm eval --model google/gemini-3.8-flash   # same corpus, any OpenRouter model
pnpm eval --patterns-only  # baseline with no AI
pnpm eval --sweep-only     # the answer key's names, no AI: what spelling search alone finds
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

AI calls go through [OpenRouter](https://openrouter.ai), so any model works, including free ones. By default every call uses a list of free models from three labs, in order: `nvidia/nemotron-3.5-super-vl:free` (chosen by the catch-rate score above), then `dots-studio/dots-3-note-preview:free`, then `google/gemma-4-31b-it:free` (`DEFAULT_MODELS` in `src/lib/detect/llm.ts`). A call moves down the list when a model has been removed, has started charging, rejects the request, or keeps failing after retries. A model that's gone or charging is skipped for the rest of the run, and the batch shows a warning saying which one to replace. A bad API key stops right away, since no other model would help.

`REDACTION_MODEL` replaces the list: one model id, or several separated by commas to try in order. A single model means no fallback, so a paid zero-retention model is never swapped for a free one that logs prompts. `REDACTION_MODEL_CAST`, `REDACTION_MODEL_SCAN`, and `REDACTION_MODEL_RESOLVE` override it per stage, in the same format; for example, use a cheaper model for the page-by-page scan. `REDACTION_EFFORT` (default `medium`) sets reasoning effort. Models with strict structured output get the JSON schema enforced; models without it get the schema in the prompt, and every answer is validated either way. Free models run 4 calls at a time (`REDACTION_CONCURRENCY`) to stay under their rate limits.

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
src/lib/history.ts      Reads the audit log back as each entity's and each mention's history
src/lib/carry-over.ts   Matches a re-run's results to the earlier ones so decisions carry over
src/components/review/  The review screen
src/app/api/            Upload, actions, search, page images, export, audit CSV
scripts/eval.mts        Catch-rate score
eval/corpus/            Synthetic documents + answer key
```

## Not in this version

- Scanned PDFs (would need OCR); the app says so if a PDF has no text.
- Real accounts. The reviewer's name is a cookie; the audit log trusts it.
- Phone numbers, emails, dates of birth, and account numbers aren't redaction categories yet. The policy text in `src/lib/detect/llm.ts` and the entity types are the places to extend.
