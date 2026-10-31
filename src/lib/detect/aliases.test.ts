import { describe, expect, it } from "vitest";
import {
  addressVariants,
  aliasKey,
  compileAliases,
  findAliases,
  isAliasOf,
  isCommonWord,
  personKey,
  personPatterns,
  personVariants,
} from "./aliases";

describe("personVariants", () => {
  it("generates the spellings legal documents use", () => {
    expect(personVariants("John A. Smith")).toEqual(
      expect.arrayContaining(["John A. Smith", "John Smith", "J. Smith", "Smith, John", "Mr. Smith", "Mrs. Smith", "Smith", "John"]),
    );
  });
  it("drops suffixes", () => {
    expect(personVariants("Robert Lee Jr.")).toContain("Mr. Lee");
  });
});

describe("findAliases", () => {
  it("matches across line breaks, in caps, and in possessives", () => {
    const text = "Defendant John\nSmith (SMITH, JOHN) said Smith's car was red.";
    const hits = findAliases(text, ["John Smith", "Smith, John", "Smith"]).map((h) => h.text);
    expect(hits).toEqual(["John\nSmith", "SMITH, JOHN", "Smith"]);
  });
  it("prefers the longest match and respects word boundaries", () => {
    const hits = findAliases("Mr. Smith met Smithson.", ["Smith", "Mr. Smith"]).map((h) => h.text);
    expect(hits).toEqual(["Mr. Smith"]);
  });
  it("does not match lowercase single words", () => {
    expect(findAliases("the marsh was wet; Marsh arrived", ["Marsh"]).map((h) => h.text)).toEqual(["Marsh"]);
  });
});

describe("helpers", () => {
  it("treats ordinary words as unsafe to search alone", () => {
    expect(isCommonWord("Will")).toBe(true);
    expect(isCommonWord("May")).toBe(true);
    expect(isCommonWord("Will Marsh")).toBe(false);
    expect(isCommonWord("Smith")).toBe(false);
  });
  it("normalizes keys", () => {
    expect(aliasKey("Mr. Smith's")).toBe("mr smith");
    expect(personKey("Mr. John A. Smith")).toBe("john smith");
    expect(personKey("Officer John Smith")).toBe("john smith");
    expect(personKey("SMITH, JOHN A.")).toBe("john smith");
  });
  it("never merges a father and son", () => {
    expect(personKey("John Smith Jr.")).toBe("john smith jr");
    expect(personKey("John A. Smith, Sr.")).toBe("john smith sr");
  });
  it("matches street types, directions, and states spelled out or abbreviated", () => {
    const re = (alias: string) => compileAliases([alias], { address: true });
    const hits = (text: string, alias: string) => findAliases(text, re(alias)).map((h) => h.text);
    expect(hits("lived at 1418 ELM ST, BALTIMORE MD 21218.", "1418 Elm Street, Baltimore, MD 21218")).toEqual(["1418 ELM ST, BALTIMORE MD 21218"]);
    expect(hits("3306 Linden Court, Apartment 2B, Towson, Maryland 21204", "3306 Linden Ct., Apt. 2B, Towson, MD 21204")).toHaveLength(1);
    expect(hits("100 North Calvert St.", "100 N. Calvert Street")).toEqual(["100 North Calvert St."]);
  });
  it("adds the house number with the bare street name", () => {
    expect(addressVariants("1418 Elm Street, Baltimore, MD")).toEqual(expect.arrayContaining(["1418 Elm Street", "Elm Street", "1418 Elm"]));
  });
});

describe("name forms the model may not list", () => {
  it("uses professional titles instead of Mr./Ms. for officials", () => {
    const v = personVariants("Officer Kevin Chen");
    expect(v).toEqual(expect.arrayContaining(["Ofc. Chen", "Officer Chen", "Ofc. K. Chen", "Officer Kevin Chen", "K. Chen", "Chen"]));
    expect(v).not.toContain("Ms. Chen");
    expect(v).not.toContain("Officer");
    // The title can come from the aliases when the label leaves it out.
    expect(personVariants("Kevin Chen", { aliases: ["Officer Chen"] })).toContain("Ofc. Chen");
    expect(personVariants("Hon. Patricia Alvarez")).toContain("Judge Alvarez");
  });
  it("adds nicknames", () => {
    expect(personVariants("Stephen M. Smith")).toEqual(expect.arrayContaining(["Steve", "Steve Smith"]));
    expect(personVariants("William Marsh")).toEqual(expect.arrayContaining(["Will", "Bill", "Will Marsh"]));
    expect(personVariants("Mary Smith")).not.toContain("May");
  });
  it("adds dotted initials only when asked, and never ones that mean something else", () => {
    expect(personVariants("Emily R. Smith")).not.toContain("E.S.");
    expect(personVariants("Emily R. Smith", { initials: true })).toEqual(expect.arrayContaining(["E.S.", "E.R.S."]));
    expect(personVariants("Linda Pruitt", { initials: true })).not.toContain("L.P.");
    const hits = findAliases("E.S. and E. S. went; e.s. is not her; U.S. neither", compileAliases(["E.S."])).map((h) => h.text);
    expect(hits).toEqual(["E.S.", "E. S."]);
  });
  it("matches middle names and initials the label doesn't have", () => {
    const patterns = personPatterns("John Smith");
    const hits = (text: string) => findAliases(text, patterns).map((h) => h.text);
    expect(hits("JOHN ANDREW SMITH and John A Smith")).toEqual(["JOHN ANDREW SMITH", "John A Smith"]);
    expect(hits("SMITH, JOHN ANDREW signed; MARSH")).toEqual(["SMITH, JOHN ANDREW"]);
    expect(hits("John and Smith")).toEqual([]);
  });
  it("matches an alias given in capitals in ordinary case too, and either apostrophe", () => {
    expect(findAliases("Johnny and JOHNNY", ["JOHNNY"]).map((h) => h.text)).toEqual(["Johnny", "JOHNNY"]);
    expect(findAliases("Ms. O’Brien and O'BRIEN", ["O'Brien"]).map((h) => h.text)).toEqual(["O’Brien", "O'BRIEN"]);
    expect(aliasKey("O’Brien’s")).toBe(aliasKey("O'Brien"));
  });
  it("tells a name form from a role phrase", () => {
    expect(isAliasOf("the younger Mr. Smith", "Stephen M. Smith")).toBe(true);
    expect(isAliasOf("Reporting Officer", "Kevin Chen")).toBe(false);
    expect(isAliasOf("Courtroom Clerk to Judge Alvarez", "Andrea Ferris")).toBe(false);
    expect(isAliasOf("SMITH, EMILY R.", "E.S.", ["Emily", "Emmy"])).toBe(true);
    expect(isAliasOf("Johnny", "John A. Smith")).toBe(true);
  });
});

describe("false-positive guards", () => {
  it("never searches for role words like Defendant", async () => {
    const { isSearchableAlias } = await import("./aliases");
    expect(isSearchableAlias("Defendant")).toBe(false);
    expect(isSearchableAlias("the Defendant")).toBe(false);
    expect(isSearchableAlias("the minor child")).toBe(false);
    expect(isSearchableAlias("Johnny")).toBe(true);
    expect(isSearchableAlias("E.S.")).toBe(true);
    expect(isSearchableAlias("Director, Human Resources & Compliance")).toBe(false);
  });
  it("skips a surname that's part of a company, street, or Bates number", async () => {
    const { isPartOfOtherName } = await import("./aliases");
    const at = (text: string, word: string) => isPartOfOtherName(text, text.indexOf(word), text.indexOf(word) + word.length);
    expect(at("a Smith & Wesson revolver", "Smith")).toBe(true);
    expect(at("2300 Smith Avenue", "Smith")).toBe(true);
    expect(at("Bates SMITH-DEF-000014", "SMITH")).toBe(true);
    expect(at("Mr. Smith arrived", "Smith")).toBe(false);
  });
  it("extends names over possessives", async () => {
    const { withPossessive } = await import("./aliases");
    const text = "Ms. Chen's statement and Chen’s car";
    expect(text.slice(0, withPossessive(text, "Ms. Chen".length))).toBe("Ms. Chen's");
    expect(withPossessive("Chens", 4)).toBe(4);
    expect(withPossessive("MS. CHEN'S", 8)).toBe(10);
  });
  it("extends names back over honorifics", async () => {
    const { withHonorific } = await import("./aliases");
    expect(withHonorific("Q. Mr. Smith", "Q. Mr. ".length)).toBe(3);
    expect(withHonorific("MS. CHEN", 4)).toBe(0);
    expect(withHonorific("Amr. Smith", 5)).toBe(5);
  });
});

describe("isNameInContext", () => {
  it("matches common-word names only where they can't be the ordinary word", async () => {
    const { isNameInContext } = await import("./aliases");
    const check = (text: string, word: string) => isNameInContext(text, text.indexOf(word), text.indexOf(word) + word.length);
    expect(check("I asked Will about the invoices.", "Will")).toBe(true);
    expect(check("Q. Will you state your name?", "Will")).toBe(false);
    expect(check("A. Yes. Will was the shift supervisor.", "Will")).toBe(true);
    expect(check("Price fell backward down the stairs.", "Price")).toBe(true);
    expect(check("Price was not discussed.", "Price")).toBe(true);
    expect(check("Rose to her feet.", "Rose")).toBe(false);
    expect(check("It happened on May 3, 2024.", "May")).toBe(false);
    expect(check("She moved out in May.", "May")).toBe(false);
    expect(check("May I approach?", "May")).toBe(false);
    expect(check("Officer Diaz spoke with May about the truck.", "May")).toBe(true);
    expect(check("the price was high", "price")).toBe(false);
    expect(check("the guard, Mr. Price, fell", "Price")).toBe(true);
  });
});
