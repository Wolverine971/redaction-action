import { describe, expect, it } from "vitest";
import { findCaseCitations, findSsns, isPlausibleSsn } from "./patterns";

const kinds = (text: string) => findSsns(text).map((h) => [h.text, h.kind, h.decision]);

describe("findSsns", () => {
  it("finds dashed, masked, spaced, bare and last-four forms", () => {
    expect(kinds("SSN: 212-45-6789.")).toEqual([["212-45-6789", "full", "redact"]]);
    expect(kinds("on file as XXX-XX-6789 and ***-**-1234")).toEqual([
      ["XXX-XX-6789", "masked", "redact"],
      ["***-**-1234", "masked", "redact"],
    ]);
    expect(kinds("Social Security No. 212 45 6789")).toEqual([["212 45 6789", "full", "redact"]]);
    expect(kinds("SSN 212456789")).toEqual([["212456789", "full", "redact"]]);
    expect(kinds("the last four digits of his Social Security number are 6789")).toEqual([["6789", "last4", "redact"]]);
    expect(kinds("SSN ending in 4321")).toEqual([["4321", "last4", "redact"]]);
  });

  it("ignores numbers that aren't SSNs", () => {
    expect(findSsns("Routing No. 052000113")).toEqual([]);
    expect(findSsns("Call (410) 555-0142 or 410-555-0142")).toEqual([]);
    expect(findSsns("EIN 52-1234567, Case No. 24-CR-004512, ZIP 21201-3456")).toEqual([]);
    expect(findSsns("Invoice 123456789 was paid on 03/14/2024")).toEqual([]);
    expect(findSsns("He paid $4,321 in 2024")).toEqual([]);
  });

  it("flags SSN-shaped numbers labeled as something else as keep", () => {
    expect(kinds("Account No. 212-45-6789")).toEqual([["212-45-6789", "full", "keep"]]);
    // The nearest label wins, even after an SSN earlier on the line.
    expect(kinds("TIN on file: XXX-XX-6789 (SSN; no EIN provided) Customer ID (CIF): 307-41-8826")).toEqual([
      ["XXX-XX-6789", "masked", "redact"],
      ["307-41-8826", "full", "keep"],
    ]);
  });

  it("doesn't mistake years in nearby dates for last-four digits", () => {
    expect(kinds("SSN on file: XXX-XX-4102 Employment Dates: 03/07/2022 (temp) -- 10/14/2022")).toEqual([
      ["XXX-XX-4102", "masked", "redact"],
    ]);
    expect(kinds("SSN ending in 4102, hired in 2022")).toEqual([["4102", "last4", "redact"]]);
  });

  it("knows which numbers the SSA never issues", () => {
    expect(isPlausibleSsn("212456789")).toBe(true);
    expect(isPlausibleSsn("666456789")).toBe(false);
    expect(isPlausibleSsn("912456789")).toBe(false);
    expect(isPlausibleSsn("212006789")).toBe(false);
  });
});

describe("findCaseCitations", () => {
  it("finds the parties around v.", () => {
    const text = "Counsel relies on Smith v. Jones, 512 U.S. 218 (1994), and State of Maryland v. John Smith.";
    expect(findCaseCitations(text).map((c) => c.text)).toEqual(["Smith v. Jones", "State of Maryland v. John Smith"]);
  });

  it("finds short-form cites", () => {
    expect(findCaseCitations("as held in Smith, 512 U.S. at 224, the rule").map((c) => c.text)).toEqual(["Smith, 512 U.S. at 224"]);
  });

  it("drops signal words and stops at sentence ends", () => {
    const text = "The court agreed. See Garcia v. United States, 469 U.S. 70.";
    expect(findCaseCitations(text).map((c) => c.text)).toEqual(["Garcia v. United States"]);
  });
});
