import { describe, expect, it } from "vitest";
import { sectionSizes } from "./detect/sections";
import { DEFAULT_SPEED, fitSpeed, formatDuration, lanesFinish, lineSeconds, planBatch, sectionSeconds, shapeOf } from "./estimate";
import { replay } from "./estimate-replay";
import { smoothCountdown } from "./progress";

// Section sizes of the 10-document sample case (eval/corpus), as the scanner splits them.
const SAMPLE = [5067, 9283, 13962, 10086, 5261, 6004, 3777, 7853, 4040, 3617, 2909];
const SAMPLE_SHAPE = { chars: 71859, sections: SAMPLE, cast: true };
const planned = SAMPLE.map((n) => sectionSeconds(DEFAULT_SPEED, n, SAMPLE.length));

/** Replays the sample with each section taking `factor(i)` × its plan. */
function sample(factor: (i: number) => number, cast = 68, resolveCalls = [40, 40]) {
  return replay({ shape: SAMPLE_SHAPE, actual: { cast, sections: planned.map((p, i) => p * factor(i)), resolveCalls } });
}

const VARIED = [1.3, 0.8, 1.5, 1.1, 0.9, 1.2, 1.4, 0.7, 1.0, 1.25, 0.95];

describe("plan", () => {
  it("splits documents into sections the way the scanner does", () => {
    expect(sectionSizes([6000, 6000, 6000])).toEqual([12000, 6000]);
    expect(sectionSizes([20000, 100])).toEqual([20000, 100]);
    expect(shapeOf([{ sections: [9000] }, { sections: [8000] }])).toEqual({ chars: 17000, sections: [9000, 8000], cast: true });
  });

  it("reads a batch that fits in one section in a single pass", () => {
    expect(shapeOf([{ sections: [5000] }, { sections: [7000] }])).toEqual({ chars: 12000, sections: [12000], cast: false });
  });

  it("runs sections a few at a time, each in the first free lane", () => {
    expect(lanesFinish([10, 10, 10, 10, 10], 4)).toBe(20);
    expect(lanesFinish([5], 2, [7, 1])).toBe(7);
    expect(lanesFinish([], 4)).toBe(0);
  });

  it("lands between the runs measured on the free model", () => {
    // The sample case ran twice on the same input: 504s and 746s. A 3-doc batch in one pass: 128s and 148s.
    const sampleTotal = planBatch(SAMPLE_SHAPE, DEFAULT_SPEED).total;
    expect(sampleTotal).toBeGreaterThan(504);
    expect(sampleTotal).toBeLessThan(746);
    const small = planBatch(shapeOf([{ sections: [12724] }]), DEFAULT_SPEED).total;
    expect(small).toBeGreaterThan(110);
    expect(small).toBeLessThan(200);
  });
});

describe("live countdown", () => {
  const minutes = (s: number) => Math.round(s / 60);

  it("never shows more than it promised when sections finish at different times (the old 11 → 22 min jump)", () => {
    const r = sample((i) => VARIED[i]);
    expect(Math.max(...r.points.map((p) => p.shown))).toBeLessThanOrEqual(r.plan.total);
  });

  it("counts down steadily: the minute shown never goes up, and stays within about a minute of the truth", () => {
    const onPlan = sample(() => 1);
    const varied = sample((i) => VARIED[i]);
    const fast = sample(() => 0.6, 40, [25]);
    for (const r of [onPlan, varied, fast]) {
      r.points.forEach((p, i) => i > 0 && expect(minutes(p.shown)).toBeLessThanOrEqual(minutes(r.points[i - 1].shown)));
    }
    for (const r of [onPlan, varied]) {
      const later = r.points.filter((p) => p.t > r.total * 0.3);
      expect(later.every((p) => Math.abs(p.shown - p.truth) < 75)).toBe(true);
    }
    // A fast streak is only half-trusted (one call can still hang), so a fast run errs long, never short.
    expect(fast.points.every((p) => p.shown > p.truth - 30)).toBe(true);
  });

  it("notices a busy model early and catches up with it", () => {
    const r = sample(() => 2, 140, [80, 80]);
    const later = r.points.filter((p) => p.t > r.total * 0.3);
    expect(later.reduce((n, p) => n + Math.abs(p.shown - p.truth), 0) / later.length).toBeLessThan(75);
  });

  it("holds steady instead of climbing while one section hangs, and says it's waiting", () => {
    const r = sample((i) => (i === 2 ? 600 / planned[2] : 1));
    expect(r.points.some((p) => p.waiting)).toBe(true);
    for (let i = 10; i < r.points.length; i++) {
      // Over any 10 seconds the number shown drops by close to 10, or at worst rises a little.
      expect(r.points[i].shown - r.points[i - 10].shown).toBeLessThan(15);
    }
  });

  it("handles the real run from 2026-10-30, where one section took 5 minutes", () => {
    // Every call's measured time from batch d5b0f2a0 on the free model. It took 746s; the old countdown showed 22 min.
    const r = replay({
      shape: SAMPLE_SHAPE,
      actual: { cast: 103.8, sections: [60.8, 154, 184.8, 116.1, 72, 66.3, 67.4, 323.5, 35.2, 105.1, 66.2], resolveCalls: [43, 164.3, 104.4] },
    });
    expect(Math.abs(r.plan.total - r.total) / r.total).toBeLessThan(0.25);
    expect(Math.max(...r.points.map((p) => p.shown))).toBeLessThanOrEqual(r.plan.total + 60);
    // While the slow section hangs, the screen says it's waiting on the model instead of a made-up countdown.
    expect(r.points.filter((p) => p.t >= 430 && p.t <= 570).every((p) => p.waiting)).toBe(true);
    const upticks = r.points.filter((p, i) => i > 0 && minutes(p.shown) > minutes(r.points[i - 1].shown));
    expect(upticks.length).toBeLessThanOrEqual(1);
  });

  it("handles the second real run, where one section took 9 minutes", () => {
    // Batch 31c07dc0, same sample, same day: 730s. Section 4 started at 100s and took 531s.
    const r = replay({
      shape: SAMPLE_SHAPE,
      actual: { cast: 100, sections: [114, 89.8, 111.8, 531, 160.3, 99.8, 45.6, 91.5, 43.4, 115.2, 73.8], resolveCalls: [98.6, 74.4] },
    });
    expect(Math.abs(r.plan.total - r.total) / r.total).toBeLessThan(0.25);
    expect(r.points.filter((p) => p.t >= 500 && p.t <= 620).every((p) => p.waiting)).toBe(true);
    const upticks = r.points.filter((p, i) => i > 0 && minutes(p.shown) > minutes(r.points[i - 1].shown));
    expect(upticks.length).toBeLessThanOrEqual(1);
  });

  it("eases toward a new estimate instead of jumping, and the bar never moves back", () => {
    const start = smoothCountdown(null, { key: "a", at: 0, target: 300, elapsed: 0 });
    const worse = smoothCountdown(start, { key: "a", at: 1000, target: 600, elapsed: 1 });
    expect(worse.left - start.left).toBeLessThan(20);
    expect(worse.fraction).toBeGreaterThanOrEqual(start.fraction);
    const better = smoothCountdown(start, { key: "a", at: 1000, target: 100, elapsed: 1 });
    expect(better.left).toBeLessThan(270);
    // A retry is a new run: start over.
    expect(smoothCountdown(start, { key: "b", at: 1000, target: 50, elapsed: 0 }).left).toBe(50);
  });
});

describe("learning from finished batches", () => {
  it("uses the built-in speeds until a batch finishes", () => {
    expect(fitSpeed([], 6)).toEqual({ ...DEFAULT_SPEED, lanes: 6 });
  });

  it("refits each stage from what runs measured, trusting one run halfway", () => {
    const speed = fitSpeed([
      {
        lanes: 4,
        cast: { chars: 71859, seconds: 136 },
        sections: SAMPLE.map((n) => ({ chars: n, seconds: 2 * sectionSeconds(DEFAULT_SPEED, n, SAMPLE.length) })),
        resolve: { seconds: 30, calls: [30] },
      },
    ]);
    // Every section took twice its plan: the scan is planned 1.5× as long from now on.
    expect(speed.section.overhead).toBeCloseTo(1.5 * DEFAULT_SPEED.section.overhead, 1);
    expect(speed.section.perKChar).toBeCloseTo(1.5 * DEFAULT_SPEED.section.perKChar, 2);
    expect(lineSeconds(speed.cast, 71859)).toBeCloseTo((136 + lineSeconds(DEFAULT_SPEED.cast, 71859)) / 2, 0);
    expect(speed.resolveCall).toBeCloseTo((30 + DEFAULT_SPEED.resolveCall) / 2, 0);
    expect(speed.samples).toBe(1);
  });

  it("prices in a section that hangs, even when most calls are fast", () => {
    // The real run from 2026-10-30: 10 of 11 sections were quick, one took 323s, and the scan took 477s.
    const sections = [60.8, 154, 184.8, 116.1, 72, 66.3, 67.4, 323.5, 35.2, 105.1, 66.2].map((seconds, i) => ({ chars: SAMPLE[i], seconds }));
    const speed = fitSpeed([{ lanes: 4, cast: { chars: 71859, seconds: 103.8 }, sections, resolve: { seconds: 164.4, calls: [43, 164.3] } }]);
    expect(planBatch(SAMPLE_SHAPE, speed).total).toBeGreaterThan(planBatch(SAMPLE_SHAPE, DEFAULT_SPEED).total);
  });
});

it("formats durations for people", () => {
  expect(formatDuration(42)).toBe("40 sec");
  expect(formatDuration(733)).toBe("12 min");
  expect(formatDuration(5400)).toBe("1 hr 30 min");
});
