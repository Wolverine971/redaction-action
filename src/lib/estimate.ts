import { SECTION_CHARS } from "@/lib/detect/sections";

/**
 * How long a batch takes, planned stage by stage the way the pipeline runs it:
 *   1. who's-who read: one model call over the whole batch (skipped when the batch fits in one section)
 *   2. scan: one call per section, a few at a time ("lanes")
 *   3. shared-name check: a handful of short calls, only when two people share a name
 * The same plan is shown before you start and counted down live, refined by how fast calls actually finish.
 * Speeds start from runs measured on the free Nemotron model and refit from every finished batch.
 */

/** seconds = overhead + perKChar × thousands of characters */
export interface Line {
  overhead: number;
  perKChar: number;
}

export interface Speed {
  /** The who's-who read of the whole batch. */
  cast: Line;
  /** One scan section, when it's the only call running. */
  section: Line;
  /** How much each extra call running at the same time slows every call down (free endpoints queue). */
  crowding: number;
  /** One shared-name double-check call, when it's the only call running. */
  resolveCall: number;
  /** Model calls that run at the same time. */
  lanes: number;
  /** Finished batches the speed was fitted from (0 = built-in defaults). */
  samples: number;
}

// Measured 2026-10-30 on nvidia/nemotron-3.5-super-vl:free. The 10-doc sample (71.9k chars in 11 sections, 4 at
// a time) ran twice: who's-who 69s / 104s, scan 356s / 477s, shared names 79s / 164s, total 504s / 746s. The same
// work swings ±25% run to run, and a single call can take 2–3× its usual time, so these sit between the two runs.
// 3-doc batch (12.7k chars, one section alone): scan 79–133s, one shared-name call 15–49s. Four calls at once
// each take ~1.6× as long.
export const DEFAULT_SPEED: Speed = {
  cast: { overhead: 25, perKChar: 0.85 },
  section: { overhead: 53, perKChar: 5.6 },
  crowding: 0.2,
  resolveCall: 55,
  lanes: 4,
  samples: 0,
};

/** Saving results once the model is done. */
export const SAVE_SECONDS = 3;

/** Shared names to double-check grow with the batch: about one call per this many characters (sample: 3 calls). */
const RESOLVE_CHARS_PER_CALL = 25_000;

/** When a call runs past its plan, assume this share of its planned time is still left (instead of counting up). */
const OVERRUN_SHARE = 0.15;

/** Seconds past its plan before a call counts as stuck, and the screen says it's waiting on the model. */
export const STALL_GRACE = 10;

/** What the model will be asked to read. */
export interface Shape {
  chars: number;
  /** Characters per scan section, in the order they run. */
  sections: number[];
  /** Whether the separate who's-who read runs. */
  cast: boolean;
}

/** Seconds per stage, planned before the batch starts. */
export interface Plan {
  cast: number;
  scan: number;
  resolve: number;
  total: number;
}

/** One model call, for the live countdown and for learning the model's speed. Times are epoch ms. */
export interface CallTiming {
  /** Characters for a scan section; mentions for a shared-name call. */
  size: number;
  startedAt: number | null;
  seconds: number | null;
  failed?: boolean;
}

/** What a finished batch measured, stored with its stats so later estimates learn from it. */
export interface RunTiming {
  lanes: number;
  cast: { chars: number; seconds: number } | null;
  sections: { chars: number; seconds: number }[];
  /** The whole shared-name stage (0 when no names needed it) and each of its calls. */
  resolve: { seconds: number; calls: number[] };
}

export function lineSeconds(line: Line, chars: number): number {
  return line.overhead + (line.perKChar * chars) / 1000;
}

/** How much slower each call runs when `calls` of them share the lanes. */
export function crowdingFactor(speed: Pick<Speed, "crowding" | "lanes">, calls: number): number {
  return 1 + speed.crowding * (Math.max(1, Math.min(speed.lanes, calls)) - 1);
}

/** One shared-name call's expected seconds, when `calls` of them run. */
export function resolveSeconds(speed: Speed, calls: number): number {
  return speed.resolveCall * crowdingFactor(speed, calls);
}

/** One scan section's expected seconds, in a batch of `sectionCount` sections. */
export function sectionSeconds(speed: Speed, chars: number, sectionCount: number): number {
  return lineSeconds(speed.section, chars) * crowdingFactor(speed, sectionCount);
}

/** Builds the shape from each document's section sizes. Mirrors the pipeline's single-pass rule. */
export function shapeOf(documents: { sections: number[] }[]): Shape {
  const sections = documents.flatMap((d) => d.sections).filter((n) => n > 0);
  const chars = sections.reduce((a, b) => a + b, 0);
  if (chars <= SECTION_CHARS) return { chars, sections: chars > 0 ? [chars] : [], cast: false };
  return { chars, sections, cast: true };
}

/**
 * When the last of a set of calls finishes, given `lanes` running at once: each queued call goes to
 * whichever lane frees up first, exactly like the pipeline's worker pool. `busy` is time left on calls already running.
 */
export function lanesFinish(queued: number[], lanes: number, busy: number[] = []): number {
  const free = [...busy];
  while (free.length < Math.max(1, lanes)) free.push(0);
  for (const seconds of queued) {
    let soonest = 0;
    for (let i = 1; i < free.length; i++) if (free[i] < free[soonest]) soonest = i;
    free[soonest] += seconds;
  }
  return Math.max(0, ...free);
}

export function planBatch(shape: Shape, speed: Speed): Plan {
  if (shape.sections.length === 0) return { cast: 0, scan: 0, resolve: 0, total: SAVE_SECONDS };
  const cast = shape.cast ? lineSeconds(speed.cast, shape.chars) : 0;
  const scan = lanesFinish(
    shape.sections.map((n) => sectionSeconds(speed, n, shape.sections.length)),
    speed.lanes,
  );
  const resolveCalls = Math.max(1, Math.ceil(shape.chars / RESOLVE_CHARS_PER_CALL));
  const resolve = lanesFinish(Array(resolveCalls).fill(resolveSeconds(speed, resolveCalls)), speed.lanes);
  return {
    cast: Math.round(cast),
    scan: Math.round(scan),
    resolve: Math.round(resolve),
    total: Math.round(cast + scan + resolve + SAVE_SECONDS),
  };
}

/** Seconds left in a single-call stage. Past its plan it holds steady instead of climbing. */
export function stageLeft(planned: number, age: number): number {
  return Math.max(planned - age, OVERRUN_SHARE * planned);
}

/** How a run is going against its plan, from one measured stage: 1 = on plan, 2 = twice as slow. Half-trusted. */
export function paceFrom(actualSeconds: number, plannedSeconds: number): number {
  return plannedSeconds > 0 ? clamp((actualSeconds / plannedSeconds + 1) / 2, 0.4, 3) : 1;
}

export interface CallsLeft {
  left: number;
  /** This run's pace so far: 1 = on plan, 2 = twice as slow. */
  pace: number;
  /** Set when every call still running is past its plan: there's no honest countdown, only a wait. */
  stuck: { calls: number; longest: number; after: number } | null;
}

/**
 * Seconds until a set of calls finishes, and this run's pace (1 = on plan). Pace is learned from calls already
 * done, plus one imaginary call at `priorPace` (what earlier stages showed) so the first result can't swing it
 * far. A call still running longer than that pace allows can only raise it: it will take at least that long.
 */
export function callsLeft(
  calls: CallTiming[],
  expected: (size: number) => number,
  lanes: number,
  now: number,
  priorPace = 1,
): CallsLeft {
  if (calls.length === 0) return { left: 0, pace: priorPace, stuck: null };
  const prior = calls.reduce((n, c) => n + expected(c.size), 0) / calls.length;
  let actual = prior * priorPace;
  let planned = prior;
  for (const c of calls) {
    if (c.seconds === null) continue;
    actual += c.seconds;
    planned += expected(c.size);
  }
  const settled = actual / planned;
  for (const c of calls) {
    if (c.seconds !== null || c.startedAt === null) continue;
    const e = expected(c.size);
    const age = (now - c.startedAt) / 1000;
    if (age > e * settled) {
      actual += age;
      planned += e;
    }
  }
  // Faster than planned is only half-trusted: on free models a quick streak doesn't rule out one call hanging.
  const measured = actual / planned;
  const pace = clamp(measured < 1 ? 1 - (1 - measured) / 2 : measured, 0.3, 5);
  const busy: number[] = [];
  const queued: number[] = [];
  const running: { age: number; overdue: boolean }[] = [];
  for (const c of calls) {
    if (c.seconds !== null) continue;
    const e = expected(c.size) * pace;
    if (c.startedAt === null) {
      queued.push(e);
      continue;
    }
    const age = (now - c.startedAt) / 1000;
    busy.push(Math.max(e - age, OVERRUN_SHARE * e));
    running.push({ age, overdue: age > e + STALL_GRACE });
  }
  const stuck =
    running.length > 0 && running.every((r) => r.overdue)
      ? { calls: running.length, longest: Math.max(...running.map((r) => r.age)), after: lanesFinish(queued, lanes) }
      : null;
  return { left: lanesFinish(queued, lanes, busy), pace, stuck };
}

/**
 * Refits the model's speed from recent finished batches. Each stage's real wall time is compared with what the
 * built-in speeds would have planned for that same batch, and the speeds are scaled to match. Stage time, not
 * per-call time, is what people wait for: a stage waits on its slowest call, so an occasional hang gets priced in.
 * The built-in speeds count as one run, so a single odd batch moves the estimate only halfway.
 */
export function fitSpeed(runs: RunTiming[], lanes = DEFAULT_SPEED.lanes): Speed {
  if (runs.length === 0) return { ...DEFAULT_SPEED, lanes };
  const d = DEFAULT_SPEED;
  const castRatios = runs.flatMap((r) => (r.cast ? [r.cast.seconds / lineSeconds(d.cast, r.cast.chars)] : []));
  const scanRatios = runs.flatMap((r) => {
    if (r.sections.length === 0) return [];
    const then = { ...d, lanes: r.lanes };
    const planned = lanesFinish(
      r.sections.map((x) => sectionSeconds(then, x.chars, r.sections.length)),
      r.lanes,
    );
    // Replaying the measured calls through the same lanes gives the stage's wall time.
    const actual = lanesFinish(
      r.sections.map((x) => x.seconds),
      r.lanes,
    );
    return planned > 0 ? [actual / planned] : [];
  });
  const resolveRatios = runs.flatMap((r) => {
    const n = r.resolve.calls.length;
    if (n === 0 || r.resolve.seconds <= 0) return [];
    const planned = lanesFinish(Array(n).fill(resolveSeconds({ ...d, lanes: r.lanes }, n)), r.lanes);
    return [r.resolve.seconds / planned];
  });
  const scale = (ratios: number[]) => clamp(shrunkMean(ratios, 1, 1), 0.3, 4);
  const [cast, scan, resolve] = [scale(castRatios), scale(scanRatios), scale(resolveRatios)];
  return {
    cast: { overhead: round(d.cast.overhead * cast, 1), perKChar: round(d.cast.perKChar * cast, 3) },
    section: { overhead: round(d.section.overhead * scan, 1), perKChar: round(d.section.perKChar * scan, 3) },
    crowding: d.crowding,
    resolveCall: round(d.resolveCall * resolve, 1),
    lanes,
    samples: runs.length,
  };
}

function shrunkMean(values: number[], prior: number, weight: number): number {
  return (values.reduce((a, b) => a + b, 0) + prior * weight) / (values.length + weight);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number, digits: number) {
  return Number(n.toFixed(digits));
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(5, Math.round(seconds / 5) * 5)} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} hr ${minutes % 60} min`;
}
