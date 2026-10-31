/** Characters of text per scan call (~4 chars per token). */
export const SECTION_CHARS = 14_000;

/**
 * Splits one document's paragraphs into scan sections of at most `max` characters, never splitting a
 * paragraph and never mixing documents. The scanner and the time estimate both use this, so the
 * estimate plans for exactly the sections that will run.
 */
export function splitSections<T>(items: T[], size: (item: T) => number, max = SECTION_CHARS): T[][] {
  const sections: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const n = size(item);
    if (chars + n > max && current.length > 0) {
      sections.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += n;
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

/** Section sizes in characters for one document, from its paragraph lengths. */
export function sectionSizes(paragraphLengths: number[], max = SECTION_CHARS): number[] {
  return splitSections(paragraphLengths, (n) => n, max).map((s) => s.reduce((a, b) => a + b, 0));
}
