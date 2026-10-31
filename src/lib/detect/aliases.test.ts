import { describe, expect, it } from "vitest";
import { addressVariants, aliasKey, findAliases, isCommonWord, personKey, personVariants } from "./aliases";

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
    expect(personKey("Mr. John A. Smith Jr.")).toBe("john smith");
  });
  it("abbreviates street names", () => {
    expect(addressVariants("1418 Elm Street, Baltimore, MD 21201")).toEqual(
      expect.arrayContaining(["1418 Elm Street", "1418 Elm St."]),
    );
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
  it("adds the bare street name for an address", () => {
    expect(addressVariants("1418 Elm Street, Baltimore, MD")).toContain("Elm Street");
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
