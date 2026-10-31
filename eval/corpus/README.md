# Redaction eval corpus

Ten synthetic PDFs (46 pages) from one fictional criminal matter, *State of Maryland v. John A. Smith*, Circuit Court for Baltimore City, No. 24-CR-004512. `truth.json` lists every PII span and every planted decoy, so a run can be scored as: **caught X% of PII, Y false positives, Z% of ambiguous "Mr. Smith" mentions attributed to the right person.**

```sh
pnpm exec tsx scripts/generate-corpus.mts   # writes pdfs/ and truth.json (deterministic, byte-identical)
pnpm exec tsx scripts/verify-corpus.mts     # re-extracts with mupdf; exits 1 on any mismatch
```

The verifier checks that every span sits at its recorded `(text, occurrence)` and `start` in mupdf's text. It also runs a **completeness lint**: every occurrence of a cast surname, first name, initials, home street name or number, or SSN digit group has to fall inside a labeled span. That means unlabeled PII can't quietly show up as a false positive.

## Policy

**Redact**
- Names of private individuals in every form. That covers parties, witnesses, victims, family and minors. Under the residual rule it also covers any named person who isn't on the keep list. Forms include full name, first or last name alone, initials (`E.S.`), nicknames (`Johnny`, `Emmy`), honorific plus surname (`Mr. Smith`), possessives (`Smith's`) and last-first caps (`SMITH, JOHN A.`).
- Home and residential addresses, full or partial (`1418 Elm Street`, `Elm Street`, `the Elm Street house`, `Elm`).
- SSNs in every form: dashed, undashed in a labeled field, spaced, masked (`XXX-XX-6789`, `***-**-4417`) and last four. For a last-four mention the span is just the four digits.

**Keep**
- Names inside citations to other cases, including short forms (`Smith, 512 U.S. at 224`, `Smith's` meaning the case, `Id. at 226`).
- Judges and court staff, attorneys of record, and police acting officially.
- Organizations and their business addresses.
- All other numbers: phone, case, account, routing, EIN, Bates, invoice, claim, badge, NPI, and DOBs. DOBs are out of policy here.

## Cast (all fictional)

| Redact | Role | Variants used |
|---|---|---|
| John A. Smith | defendant | John Smith, John A. Smith, John Andrew Smith, J. Smith, John, Johnny, Mr. Smith, Smith's, SMITH, SMITH, JOHN |
| Stephen M. Smith | son, deposed key witness | Steve, Steve Smith, Stephen Michael Smith, S. Smith, **Mr. Smith** |
| Emily R. Smith | minor granddaughter | E.S., Emily, Emmy, SMITH, EMILY R. |
| Mary E. Smith | defendant's wife | Mary, Mrs. Smith, Mary E. Smith |
| May Chen | neighbor, eyewitness | May Chen, Ms. Chen, Mrs. Chen, CHEN, MAY, Chen |
| William "Will" Marsh | coworker who reported the fraud | Will, Will Marsh, Mr. Marsh, W. Marsh, MARSH, W. |
| Carla Marsh | Will's wife | Carla, Carla Marsh |
| Darnell Price | victim (security guard) | Darnell, Mr. Price, Price, PRICE, DARNELL T. |
| Rosa Delgado | bank teller | Ms. Delgado, R. Delgado |
| Kara Delaney | E.S.'s mother | Kara, Ms. Delaney, K. Delaney |
| Linda Pruitt, Anand Rao | HR custodian, physician | redact only under the residual rule (see the note in `truth.json` if you want to flip them) |

Five home addresses and four SSNs: John 212-48-6789, Steve 219-63-4102, Mary 223-41-4417, Price 578-20-3391. Each SSN is reused across documents in different formats.

Keep-side people are Judge Patricia Alvarez, ASA Marcus Whitfield, defense attorney Lauren Okafor, Det. Brian Kowalski, Officer Kevin Chen, court reporter Denise Harmon and clerk Andrea Ferris.

## Traps and what they test

| Trap | Where | Challenge |
|---|---|---|
| "Mr. Smith" means Steve in his own deposition and John almost everywhere else, sometimes on the same page ("Mr. Smith senior") | Steve: 02, 03, 07, 10; John: 01–03, 05–09 | context, attribution |
| Four Smiths share one surname; bare `Smith` / `SMITH` / `Smith's` | all | attribution |
| `May` the witness vs. 80+ dates like `May 3, 2024` vs. "May I approach" | all | false positives |
| `Will` the coworker vs. "will" as a verb, "Will you…", "free will" | 03, 05, 08, 09, 10 | false positives |
| `Price` the victim vs. "the price per trailer"; *Price v. State* | 02, 05, 07, 09, 10 | false positives, context |
| Officer Kevin Chen vs. witness May Chen ("no relation"); bare `CHEN` for both | 02, 07, 08, 09 | context, attribution |
| `Marsh` shared by Will and Carla; *United States v. Marsh* | 02, 07, 09 | attribution, context |
| This case's caption `State v. John A. Smith` (redact) vs. *Smith v. Jones*, *Smith v. State*, `Smith, 512 U.S. at 224`, `Smith's` reasoning (keep) | 07, all headers | context |
| `Smith Avenue` business address, `Smith & Wesson`, Bates `SMITH-DEF-000014` | 01, 02, 05, 06, 09 | false positives |
| `E.S.` (minor) vs. `U.S.` inside citations | E.S.: 01–03, 05–07, 10; U.S.: 07 | false positives |
| Home addresses (1418 / 1420 Elm, Linden Ct, Pelham Ave, Harbor View Ln) vs. courthouse, bank, firm, clinic, warehouse and police addresses; `Harbor` the street vs. `Harbor Pediatric` the clinic | all | context |
| SSN-shaped decoys: CIF `307-41-8826`, claim `412-77-3051`; 9-digit routing `052000113`; EIN `52-1234567`; MD state ID `12-3456789`; ZIP+4; phones | 04, 05, 06 | false positives |
| Partial SSNs: masked tokens, "last four is 6789", "ending in 6789" | 01, 02, 03, 04, 05, 06 | false negatives |
| Names, addresses and citations wrapping across line ends (24 spans, e.g. `Darnell / Price`, `3306 Linden Court, Apt. 2B, / Towson…`) | 01, 02, 04, 06, 07, 09, 10 | extraction, span geometry |
| 21-page Q/A transcript with 272 spans; the State v. Smith running header repeats on every pleading page | 03 | volume (100+ suggestions in one doc) |
| One family, ten documents, same people in different formats | all | multi-document grouping |
| Residual-rule professionals (records custodian, physician) | 05, 06 | policy edge |

## truth.json

- `entities[]` has `id`, `type` (`person|address|ssn|org`), `canonical`, `redact` and `note`. It also carries `mentions` and `aliases[]` (every distinct span text).
- `documents[].spans[]` has `page` (1-based), `text`, `occurrence`, `expected` (`redact|keep`), `category`, `entityId` (always set on redact spans), and `ambiguous` (only present when true). Optional extras:
  - `kind`: the decoy subtype, e.g. `month`, `modal_verb`, `routing`, `bates`.
  - `start`: char offset in the normalized page text.
  - `wrapped`: true when the span crosses a line break.
  - `region`: `header` or `footer`; absent means body.

### Occurrence rule

- Page text is `page.toStructuredText("preserve-whitespace").asText()`, with every whitespace run collapsed to one space and the result trimmed. That includes running headers, footers and deposition line numbers.
- `occurrence` counts earlier start positions of the exact span text on that page. Matching is plain substring, case-sensitive and overlapping. So `Smith` inside `John Smith`, `Smith v. Jones` or `Smith Avenue` all count, and `6789` inside `212-48-6789` counts.
- Truth spans never overlap one another.
- Possessive `'s` is inside the span.
- Masked SSNs are the whole token. Last-four mentions are only the digits.
- In the deposition, spans never wrap. Line numbers would interleave with the text if they did.
