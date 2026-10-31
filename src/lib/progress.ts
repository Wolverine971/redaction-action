import type { DetectProgress, DetectStage } from "@/lib/detect/pipeline";
import { callsLeft, paceFrom, resolveSeconds, SAVE_SECONDS, sectionSeconds, STALL_GRACE, stageLeft, type Plan, type Speed } from "@/lib/estimate";

/** What the live processing view reads while a batch is running. Document keys are document ids. */
export interface BatchProgress extends Partial<DetectProgress> {
  startedAt: string;
  /** The planned total at the start, the same number the intake screen showed. */
  estimateSeconds: number;
  /** Planned seconds per stage, and the speeds behind them. Missing on batches started before stage plans. */
  plan?: Plan;
  speed?: Speed;
  chars: number;
  pages: number;
  /** When each stage began. */
  stageStartedAt: Partial<Record<DetectStage | "extract" | "save", string>>;
}

/** What the screen says about time left. */
export interface TimeLeft {
  seconds: number;
  /**
   * Set when everything left in the current stage is a call already past its plan. A countdown would be made
   * up, so the screen says what it's waiting on, for how long, and roughly how long after that.
   */
  waiting: { on: string; many: boolean; for: number; then: number } | null;
}

/**
 * Time left: the stage that's running, refined from how fast its calls are actually finishing, plus the
 * plan for every stage after it, scaled by how the run is going so far (a slow who's-who read means a busy
 * model, so the scan will likely be slow too). Each stage starts from what the previous one was counting,
 * so moving between stages doesn't jump.
 */
export function timeLeft(p: BatchProgress, now = Date.now()): TimeLeft {
  if (p.stage === "done") return { seconds: 0, waiting: null };
  const { plan, speed } = p;
  if (!plan || !speed) return { seconds: Math.max(15, p.estimateSeconds - (now - Date.parse(p.startedAt)) / 1000), waiting: null };
  const age = (s: DetectStage) => {
    const t = p.stageStartedAt[s];
    return t ? Math.max(0, (now - Date.parse(t)) / 1000) : 0;
  };
  const lanes = p.lanes ?? speed.lanes;
  const between = (from: DetectStage, to: DetectStage) => {
    const [a, b] = [p.stageStartedAt[from], p.stageStartedAt[to]];
    return a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null;
  };
  // Pace after the who's-who read (1 = on plan). While it's still running past plan, assume the rest is slow too.
  const castTook = between("cast", "scan");
  const castPace =
    castTook !== null ? paceFrom(castTook, plan.cast) : p.stage === "cast" && age("cast") > plan.cast ? paceFrom(age("cast"), plan.cast) : 1;
  const scanCalls = p.calls?.scan ?? [];
  const scan = () => callsLeft(scanCalls, (n) => sectionSeconds(speed, n, scanCalls.length), lanes, now, castPace);
  const counting = (seconds: number): TimeLeft => ({ seconds, waiting: null });
  switch (p.stage) {
    case "cast": {
      const rest = (plan.scan + plan.resolve) * castPace + SAVE_SECONDS;
      const castAge = age("cast");
      return {
        seconds: stageLeft(plan.cast, castAge) + rest,
        waiting: castAge > plan.cast * 1.25 + STALL_GRACE ? { on: "The who's-who read", many: false, for: castAge, then: rest } : null,
      };
    }
    case "scan": {
      if (scanCalls.length === 0) return counting((plan.scan + plan.resolve) * castPace + SAVE_SECONDS);
      const { left, pace, stuck } = scan();
      const rest = plan.resolve * pace + SAVE_SECONDS;
      const on = stuck && (stuck.calls > 1 ? `${stuck.calls} sections` : stuck.after > 0 ? "A section" : "The last section");
      return {
        seconds: left + rest,
        waiting: stuck && on ? { on, many: stuck.calls > 1, for: stuck.longest, then: stuck.after + rest } : null,
      };
    }
    case "sweep":
      return counting(plan.resolve * (scanCalls.length ? scan().pace : castPace) + SAVE_SECONDS);
    case "resolve": {
      const pace = scanCalls.length ? scan().pace : castPace;
      const calls = p.calls?.resolve ?? [];
      if (calls.length === 0) return counting(stageLeft(plan.resolve * pace, age("resolve")) + SAVE_SECONDS);
      const { left, stuck } = callsLeft(calls, () => resolveSeconds(speed, calls.length), lanes, now, pace);
      return {
        seconds: left + SAVE_SECONDS,
        waiting: stuck ? { on: "The shared-name check", many: false, for: age("resolve"), then: stuck.after + SAVE_SECONDS } : null,
      };
    }
    default:
      // Reading PDFs and matching SSN patterns: the model hasn't started yet.
      return counting(plan.total);
  }
}

export function secondsLeft(p: BatchProgress, now = Date.now()): number {
  return timeLeft(p, now).seconds;
}

/** The countdown as shown on screen. */
export interface Countdown {
  /** Which run this belongs to, so a retry starts fresh. */
  key: string;
  at: number;
  left: number;
  /** Progress bar, 0–1. */
  fraction: number;
}

/**
 * Ticks down one second per second, then eases toward the latest estimate: quickly when it's good news,
 * slowly when it's bad, so one fast or slow call never makes the number jump. The bar only moves forward.
 */
export function smoothCountdown(prev: Countdown | null, next: { key: string; at: number; target: number; elapsed: number }): Countdown {
  if (!prev || prev.key !== next.key) {
    return { key: next.key, at: next.at, left: next.target, fraction: shareDone(next.elapsed, next.target) };
  }
  const dt = Math.max(0, (next.at - prev.at) / 1000);
  const counted = Math.max(0, prev.left - dt);
  const gap = next.target - counted;
  const left = Math.max(0, counted + gap * (1 - Math.pow(gap > 0 ? 0.94 : 0.85, dt)));
  return { key: next.key, at: next.at, left, fraction: Math.max(prev.fraction, shareDone(next.elapsed, left)) };
}

export function shareDone(elapsed: number, left: number): number {
  return elapsed + left > 0 ? elapsed / (elapsed + left) : 0;
}
