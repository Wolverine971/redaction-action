import type { CastEntity, DetectorLLM, DisambiguateAnswer, DisambiguateInput, ScanFinding, ScanInput, Usage } from "./llm";

/**
 * A stand-in for the AI model in tests: returns a fixed cast, reports scan findings by searching for
 * configured strings, and resolves ambiguity with a caller-supplied rule.
 */
export class FakeLLM implements DetectorLLM {
  model = "fake";
  calls = { cast: 0, scan: 0, disambiguate: 0 };
  constructor(
    private readonly castList: CastEntity[],
    private readonly scanRules: { text: string; entity: string; redact?: boolean; certain?: boolean }[] = [],
    private readonly resolver: (context: string, candidateIds: string[]) => string = () => "unclear",
  ) {}
  usage(): Usage {
    return { inputTokens: 0, outputTokens: 0, calls: this.calls.cast + this.calls.scan + this.calls.disambiguate };
  }
  async cast(): Promise<CastEntity[]> {
    this.calls.cast++;
    return this.castList;
  }
  async scan(input: ScanInput): Promise<ScanFinding[]> {
    this.calls.scan++;
    const findings: ScanFinding[] = [];
    for (const block of input.blocks) {
      for (const rule of this.scanRules) {
        let i = block.text.indexOf(rule.text);
        while (i >= 0) {
          // With no known list (single-pass mode) a real model introduces each entity itself.
          const c = input.known.length === 0 ? this.castList.find((x) => x.id === rule.entity) : undefined;
          findings.push({
            block: block.id,
            text: rule.text,
            entity: rule.entity,
            new_entity: c ? { type: c.type as "person" | "address" | "org", name: c.name, role: c.role, redact: c.redact } : null,
            redact: rule.redact ?? this.castList.find((x) => x.id === rule.entity)?.redact ?? true,
            certain: rule.certain ?? true,
            note: null,
          });
          i = block.text.indexOf(rule.text, i + 1);
        }
      }
    }
    return findings;
  }
  async disambiguate(input: DisambiguateInput): Promise<DisambiguateAnswer[]> {
    this.calls.disambiguate++;
    return input.items.map((item) => {
      const candidates = item.candidateIds.map((id) => input.candidates.find((c) => c.id === id)!);
      const name = this.resolver(item.context, candidates.map((c) => c.name));
      const match = candidates.find((c) => c.name === name);
      return { id: item.id, entity: match?.id ?? "unclear", confidence: 0.9, why: "fake" };
    });
  }
}
