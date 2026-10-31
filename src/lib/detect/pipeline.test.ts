import { describe, expect, it } from "vitest";
import { FakeLLM } from "./fake-llm";
import { detect, guessEntityType, personLabel, type InputDocument } from "./pipeline";

const doc = (key: string, paragraphs: string[][]): InputDocument => ({
  key,
  name: `${key}.pdf`,
  blocks: paragraphs.flatMap((page, p) =>
    page.map((text, i) => ({ id: `${key}:${p + 1}:${i}`, page: p + 1, position: i, text })),
  ),
});

const cast = [
  { id: "john", type: "person" as const, name: "John Smith", aliases: ["John Smith", "Mr. Smith", "Johnny"], role: "defendant", redact: true, why: "private party" },
  { id: "steve", type: "person" as const, name: "Steve Smith", aliases: ["Steve Smith", "Mr. Smith"], role: "son of John; witness", redact: true, why: "private party" },
  { id: "judge", type: "person" as const, name: "Patricia Alvarez", aliases: ["Judge Alvarez"], role: "judge", redact: false, why: "official" },
  { id: "home", type: "address" as const, name: "1418 Elm Street, Baltimore, MD 21201", aliases: [], role: "John's home", redact: true, why: "home address" },
];

// Force the full two-pass path (who's-who read, then section scans) on these tiny test documents.
const MULTI_PASS = { chunkChars: 10 };

describe("detect", () => {
  const docs = [
    doc("a", [
      ["Defendant John Smith, SSN 212-45-6789, lives at 1418 Elm Street, Baltimore, MD 21201."],
      ["His son Steve Smith testified. Judge Alvarez presided.", "Counsel cited Smith v. Jones, 512 U.S. 218."],
    ]),
    doc("b", [["Johnny was seen at 1418 Elm St. on May 3. His SSN ends in 6789.", "Q. Mr. Smith, where was your father?"]]),
  ];

  it("finds every mention, sweeps variants the model missed, and keeps citations", async () => {
    // The model only reports the full names; the sweep must find "Johnny", "1418 Elm St.", and "Mr. Smith".
    const llm = new FakeLLM(cast, [
      { text: "John Smith", entity: "john" },
      { text: "Steve Smith", entity: "steve" },
    ], (context, names) => (context.includes("your father") ? "Steve Smith" : names[0]));
    const result = await detect(docs, llm, MULTI_PASS);
    const byText = (t: string) => result.mentions.filter((m) => m.text === t);

    expect(byText("John Smith")[0]).toMatchObject({ source: "llm", entityKey: "person:john" });
    expect(byText("Johnny")[0]).toMatchObject({ source: "sweep", entityKey: "person:john" });
    expect(byText("1418 Elm St.")[0]).toMatchObject({ source: "sweep", entityKey: "address:home" });
    expect(byText("212-45-6789")[0]).toMatchObject({ source: "pattern", entityKey: "ssn:212456789" });
    // The last four links back to the full SSN.
    expect(byText("6789")[0]).toMatchObject({ entityKey: "ssn:212456789" });
    // "Smith" in "Smith v. Jones" is a different case's party.
    expect(byText("Smith")[0]).toMatchObject({ aiDecision: "keep" });
    // "Mr. Smith" fits two people: flagged ambiguous and resolved from context.
    expect(byText("Mr. Smith")[0]).toMatchObject({ ambiguous: true, entityKey: "person:steve" });
    expect(byText("Mr. Smith")[0].candidateKeys.sort()).toEqual(["person:john", "person:steve"]);
    // The month "May" is never matched.
    expect(result.mentions.some((m) => m.text === "May")).toBe(false);
    // Judges are listed so the reviewer can see them, but suggested keep.
    expect(result.entities.find((e) => e.key === "person:judge")?.suggestion).toBe("keep");
  });

  it("re-asks about shared-name mentions the model skipped", async () => {
    const llm = new FakeLLM(cast, [], (_c, names) => names[1]);
    const real = llm.disambiguate.bind(llm);
    let calls = 0;
    // First call answers only the first mention; the follow-up must cover the rest.
    llm.disambiguate = async (input) => {
      calls++;
      const out = await real(input);
      return calls === 1 ? out.slice(0, 1) : out;
    };
    const result = await detect([doc("c", [["Mr. Smith left. Mr. Smith returned. Mr. Smith slept."]])], llm, MULTI_PASS);
    expect(calls).toBe(2);
    expect(result.mentions.filter((m) => m.text === "Mr. Smith").every((m) => m.guessConfidence === 0.9)).toBe(true);
  });

  it("extends a partial model match to the full name the search finds", async () => {
    const llm = new FakeLLM(cast, [{ text: "John", entity: "john" }]);
    const result = await detect([doc("e", [["The defendant, John\nSmith, left."]])], llm, MULTI_PASS);
    expect(result.mentions.map((m) => [m.text, m.source, m.entityKey])).toEqual([["John\nSmith", "llm", "person:john"]]);
  });

  it("reports live progress: stages, pages read, and finds so far", async () => {
    const llm = new FakeLLM(cast, [{ text: "John Smith", entity: "john" }]);
    const snapshots: import("./pipeline").DetectProgress[] = [];
    await detect(docs, llm, { chunkChars: 60, concurrency: 1, onProgress: (p) => void snapshots.push(structuredClone(p)) });
    const stages = [...new Set(snapshots.map((s) => s.stage))];
    expect(stages).toEqual(["patterns", "cast", "scan", "sweep", "resolve", "done"]);
    // SSNs show up before the model is called.
    expect(snapshots.find((s) => s.stage === "cast")!.found.some((f) => f.type === "ssn" && f.count > 0)).toBe(true);
    // Pages light up one section at a time and finish fully read.
    const scan = snapshots.filter((s) => s.stage === "scan");
    expect(scan.some((s) => Object.values(s.scanning).flat().length > 0)).toBe(true);
    const last = snapshots[snapshots.length - 1];
    expect(last.scanned).toEqual({ a: [1, 2], b: [1] });
    expect(last.sections.done).toBe(last.sections.total);
    expect(last.found.find((f) => f.label === "John Smith")!.count).toBeGreaterThan(1);
  });

  it("reads a small batch in a single pass, with no separate who's-who call", async () => {
    const llm = new FakeLLM(cast, [
      { text: "John Smith", entity: "john" },
      { text: "Steve Smith", entity: "steve" },
    ]);
    const result = await detect(docs, llm);
    expect(llm.calls).toMatchObject({ cast: 0, scan: 1 });
    const john = result.entities.find((e) => e.label === "John Smith")!;
    expect(john).toMatchObject({ type: "person", role: "defendant", suggestion: "redact" });
    // The sweep still finds generated spellings the model didn't report, and flags the shared one.
    const mr = result.mentions.find((m) => m.text === "Mr. Smith")!;
    expect(mr).toMatchObject({ source: "sweep", ambiguous: true });
    expect(mr.candidateKeys).toContain(john.key);
  });

  it("keeps findings when the model skips new_entity or writes paragraph ids loosely", async () => {
    const llm = new FakeLLM(cast, [
      { text: "John Smith", entity: "john" },
      { text: "1418 Elm Street, Baltimore, MD 21201", entity: "home" },
    ]);
    const scan = llm.scan.bind(llm);
    llm.scan = async (input) => (await scan(input)).map((f) => ({ ...f, new_entity: null, block: f.block.toUpperCase() }));
    const result = await detect(docs, llm);
    expect(result.entities.find((e) => e.label === "John Smith")).toMatchObject({ type: "person", suggestion: "redact" });
    expect(result.entities.find((e) => e.type === "address")?.label).toBe("1418 Elm Street, Baltimore, MD 21201");
    expect(result.warnings).toEqual([]);
  });

  it("warns when the AI scan comes back empty", async () => {
    const llm = new FakeLLM(cast, []);
    llm.scan = async () => [];
    const result = await detect(docs, llm);
    expect(result.warnings.join(" ")).toMatch(/came back empty/);
  });

  it("picks a natural label for a person the model didn't name", () => {
    expect(personLabel(["JOHN ANDREW SMITH", "Mr. Smith", "John Smith"])).toBe("John Smith");
    expect(personLabel(["JOHN ANDREW SMITH"])).toBe("John Andrew Smith");
    expect(personLabel(["CHEN, MAY"])).toBe("May Chen");
    expect(personLabel(["Ofc. K. Chen #4471", "Officer Chen"])).toBe("K. Chen");
    expect(personLabel(["Lauren Okafor, Esq."])).toBe("Lauren Okafor");
  });

  it("guesses what an unlabeled mention is", () => {
    expect(guessEntityType("212-45-6789", "x1")).toBe("ssn");
    expect(guessEntityType("52 Harbor View Lane, Dundalk", "e7")).toBe("address");
    expect(guessEntityType("Chesapeake Federal Bank", "e8")).toBe("org");
    expect(guessEntityType("May Chen", "may_chen")).toBe("person");
    expect(guessEntityType("Acme", "org_acme")).toBe("org");
  });

  it("still finds SSNs with no model", async () => {
    const result = await detect(docs, null);
    expect(result.entities.map((e) => e.type)).toEqual(["ssn"]);
    expect(result.mentions.map((m) => m.text).sort()).toEqual(["212-45-6789", "6789"]);
    expect(result.warnings[0]).toMatch(/OPENROUTER_API_KEY/);
  });
});
