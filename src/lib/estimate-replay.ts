import { DEFAULT_SPEED, planBatch, type CallTiming, type Shape, type Speed } from "@/lib/estimate";
import { smoothCountdown, timeLeft, type BatchProgress, type Countdown } from "@/lib/progress";

/**
 * Replays a batch run second by second against the live countdown, for tests and tuning.
 * `actual` gives the real seconds of each stage and call; the countdown only sees what the live view would.
 */
export interface ReplayRun {
  shape: Shape;
  speed?: Speed;
  actual: { cast: number; sections: number[]; resolveCalls: number[] };
}

export function replay(run: ReplayRun, step = 1) {
  const speed = run.speed ?? DEFAULT_SPEED;
  const plan = planBatch(run.shape, speed);
  const base = Date.parse("2026-10-30T12:00:00Z");
  const iso = (t: number) => new Date(base + t * 1000).toISOString();
  const lanes = speed.lanes;
  const schedule = (durations: number[], start: number) => {
    const free = Array.from({ length: lanes }, () => start);
    return durations.map((d) => {
      let i = 0;
      for (let j = 1; j < free.length; j++) if (free[j] < free[i]) i = j;
      const s = free[i];
      free[i] = s + d;
      return { start: s, end: s + d, seconds: d };
    });
  };
  const castEnd = run.shape.cast ? run.actual.cast : 0;
  const scan = schedule(run.actual.sections, castEnd);
  const scanEnd = Math.max(castEnd, ...scan.map((c) => c.end));
  const resolve = schedule(run.actual.resolveCalls, scanEnd);
  const resolveEnd = Math.max(scanEnd, ...resolve.map((c) => c.end));
  const total = resolveEnd + 3;

  const calls = (sched: typeof scan, sizes: number[], t: number): CallTiming[] =>
    sched.map((c, i) => ({
      size: sizes[i],
      startedAt: c.start <= t ? base + c.start * 1000 : null,
      seconds: c.end <= t ? c.seconds : null,
    }));

  const points: { t: number; truth: number; raw: number; shown: number; waiting: boolean }[] = [];
  let clock: Countdown | null = null;
  for (let t = 0; t < resolveEnd; t += step) {
    const stage = run.shape.cast && t < castEnd ? "cast" : t < scanEnd ? "scan" : resolve.length ? "resolve" : "sweep";
    const p: BatchProgress = {
      startedAt: iso(0),
      estimateSeconds: plan.total,
      plan,
      speed,
      chars: run.shape.chars,
      pages: 0,
      stage,
      lanes,
      stageStartedAt: {
        ...(run.shape.cast ? { cast: iso(0) } : {}),
        ...(t >= castEnd ? { scan: iso(castEnd) } : {}),
        ...(t >= scanEnd && resolve.length ? { resolve: iso(scanEnd) } : {}),
      },
      calls: {
        scan: t >= castEnd ? calls(scan, run.shape.sections, t) : [],
        resolve: t >= scanEnd ? calls(resolve, run.actual.resolveCalls.map(() => 20), t) : [],
      },
    };
    const now = base + t * 1000;
    const { seconds: raw, waiting } = timeLeft(p, now);
    clock = smoothCountdown(clock, { key: "run", at: now, target: raw, elapsed: t });
    points.push({ t, truth: total - t, raw, shown: clock.left, waiting: waiting !== null });
  }
  return { plan, total, points };
}
