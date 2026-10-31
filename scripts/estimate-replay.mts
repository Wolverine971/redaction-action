/**
 * Replays the sample case through the live countdown under different model speeds and prints how it holds up.
 * Use it when tuning DEFAULT_SPEED or the countdown in src/lib/estimate.ts and src/lib/progress.ts.
 *   pnpm estimate:replay
 */
import { DEFAULT_SPEED, sectionSeconds } from "@/lib/estimate";
import { replay } from "@/lib/estimate-replay";

// Section sizes of the 10-document sample case, as the scanner splits them.
const sections = [5067, 9283, 13962, 10086, 5261, 6004, 3777, 7853, 4040, 3617, 2909];
const planned = sections.map((n) => sectionSeconds(DEFAULT_SPEED, n, sections.length));
const scenarios: Record<string, { cast: number; factor: (i: number) => number; resolve: number[] }> = {
  "on plan": { cast: 68, factor: () => 1, resolve: [40, 40] },
  "varied, like the sample": { cast: 69, factor: (i) => [1.3, 0.8, 1.5, 1.1, 0.9, 1.2, 1.4, 0.7, 1.0, 1.25, 0.95][i], resolve: [55, 40] },
  "model busy (2x slower)": { cast: 140, factor: () => 2, resolve: [80, 80] },
  "model fast (0.6x)": { cast: 40, factor: () => 0.6, resolve: [25] },
  "one section hangs 10 min": { cast: 69, factor: (i) => (i === 2 ? 600 / planned[2] : 1), resolve: [40] },
};
const min = (s: number) => Math.round(s / 60);
for (const [name, s] of Object.entries(scenarios)) {
  const r = replay({
    shape: { chars: 71859, sections, cast: true },
    actual: { cast: s.cast, sections: planned.map((p, i) => p * s.factor(i)), resolveCalls: s.resolve },
  });
  const later = r.points.filter((p) => p.t > r.total * 0.3);
  const error = later.reduce((n, p) => n + Math.abs(p.shown - p.truth), 0) / later.length;
  const ticksUp = r.points.some((p, i) => i > 0 && min(p.shown) > min(r.points[i - 1].shown));
  console.log(`\n${name}: planned ${(r.plan.total / 60).toFixed(1)} min, took ${(r.total / 60).toFixed(1)} min`);
  console.log(`  average error after the first 30%: ${Math.round(error)}s · minute shown ever goes up: ${ticksUp ? "yes" : "no"}`);
  console.log(`  every 30s, shown/actual minutes left: ${r.points.filter((p) => p.t % 30 === 0).map((p) => `${min(p.shown)}/${min(p.truth)}`).join(" ")}`);
}

// The real run from 2026-10-30 (batch d5b0f2a0): every call's measured time. One section took 323s.
{
  const r = replay({
    shape: { chars: 71859, sections, cast: true },
    actual: { cast: 103.8, sections: [60.8, 154, 184.8, 116.1, 72, 66.3, 67.4, 323.5, 35.2, 105.1, 66.2], resolveCalls: [43, 164.3, 104.4] },
  });
  console.log(`\nreal run 2026-10-30: planned ${(r.plan.total / 60).toFixed(1)} min, took ${(r.total / 60).toFixed(1)} min`);
  for (const p of r.points.filter((p) => p.t % 30 === 0)) {
    console.log(`  ${String(p.t).padStart(3)}s  ${p.waiting ? "waiting on the model".padEnd(22) : `~${min(p.shown)} min left`.padEnd(22)} actually ${min(p.truth)} min left`);
  }
}
