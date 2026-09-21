import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultTolerance,
  evaluateSla,
  nextLoad,
  plateauSamples,
  roundLoadFor,
  runSearchLoop,
  type ResolvedConfig,
  type RoundLoad,
  type SearchDeps,
} from "../src/execution/breakingPointSearch.js";
import type { LabelStats } from "../src/report/aggregate.js";
import type { SampleResult } from "../src/report/jtlParser.js";

const baseConfig: ResolvedConfig = {
  startThreads: 50,
  maxThreads: 400,
  toleranceThreads: 5,
  rampSecondsPerThread: 0.1,
  plateauDurationSeconds: 60,
  cooldownSeconds: 5,
  maxIterations: 12,
};

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...baseConfig, ...overrides };
}

/** A stand-in aggregate row for a system that degrades once it passes `breaksAbove` threads. */
function overallFor(numThreads: number, breaksAbove: number): LabelStats {
  const broken = numThreads > breaksAbove;
  return {
    label: "TOTAL",
    count: 500,
    errors: broken ? 50 : 0,
    errorPct: broken ? 10 : 0,
    avgMs: broken ? 1500 : 120,
    minMs: 10,
    maxMs: broken ? 5000 : 400,
    medianMs: broken ? 1200 : 100,
    p90Ms: broken ? 1800 : 180,
    p95Ms: broken ? 2500 : 200,
    p99Ms: broken ? 4000 : 300,
    throughputPerSec: 50,
    kbPerSec: 12,
  };
}

interface Recorder {
  loads: number[];
  sleeps: number[];
  deps: SearchDeps;
}

function recorder(opts: { breaksAbove: number; stopAfter?: number; emptyAt?: number }): Recorder {
  const loads: number[] = [];
  const sleeps: number[] = [];
  let stop = false;
  const deps: SearchDeps = {
    async runRound(load: RoundLoad, iteration: number) {
      loads.push(load.numThreads);
      if (opts.emptyAt === iteration) return { executionId: `exec_${iteration}`, overall: null };
      if (opts.stopAfter === iteration) stop = true;
      return { executionId: `exec_${iteration}`, overall: overallFor(load.numThreads, opts.breaksAbove) };
    },
    async sleep(ms: number) {
      sleeps.push(ms);
    },
    stopRequested: () => stop,
    onProgress() {},
  };
  return { loads, sleeps, deps };
}

test("nextLoad starts at startThreads when nothing has run yet", () => {
  assert.equal(nextLoad({ lo: 0, hi: null }, config()), 50);
});

test("nextLoad clamps the first round to maxThreads", () => {
  assert.equal(nextLoad({ lo: 0, hi: null }, config({ startThreads: 50, maxThreads: 20 })), 20);
});

test("nextLoad doubles while bracketing and no round has broken yet", () => {
  assert.equal(nextLoad({ lo: 50, hi: null }, config()), 100);
  assert.equal(nextLoad({ lo: 100, hi: null }, config()), 200);
});

test("nextLoad caps the doubling at maxThreads instead of overshooting", () => {
  assert.equal(nextLoad({ lo: 300, hi: null }, config()), 400);
});

test("nextLoad ends the search when the ceiling itself held", () => {
  assert.equal(nextLoad({ lo: 400, hi: null }, config()), null);
});

test("nextLoad bisects once a round has broken", () => {
  assert.equal(nextLoad({ lo: 100, hi: 200 }, config()), 150);
});

test("nextLoad stops once the bounds are within tolerance", () => {
  assert.equal(nextLoad({ lo: 130, hi: 135 }, config({ toleranceThreads: 5 })), null);
  assert.equal(nextLoad({ lo: 130, hi: 136 }, config({ toleranceThreads: 5 })), 133);
});

test("nextLoad stops when the midpoint is no longer strictly between the bounds", () => {
  assert.equal(nextLoad({ lo: 10, hi: 11 }, config({ toleranceThreads: 0 })), null);
});

test("nextLoad bisects downward when even the first round broke", () => {
  assert.equal(nextLoad({ lo: 0, hi: 50 }, config()), 25);
});

test("defaultTolerance is 2% of the ceiling, with a floor of 5 threads", () => {
  assert.equal(defaultTolerance(100), 5);
  assert.equal(defaultTolerance(1000), 20);
});

test("roundLoadFor scales ramp-up with the load and adds the plateau on top", () => {
  assert.deepEqual(roundLoadFor(100, { rampSecondsPerThread: 0.1, plateauDurationSeconds: 60 }), {
    numThreads: 100,
    rampTimeSeconds: 10,
    durationSeconds: 70,
  });
});

test("roundLoadFor never ramps in less than a second", () => {
  const load = roundLoadFor(2, { rampSecondsPerThread: 0.1, plateauDurationSeconds: 30 });
  assert.equal(load.rampTimeSeconds, 1);
  assert.equal(load.durationSeconds, 31);
});

function sample(timestamp: number, elapsed = 100): SampleResult {
  return { timestamp, elapsed, label: "req", responseCode: "200", success: true, bytes: 100, latency: elapsed };
}

test("plateauSamples drops the samples taken during ramp-up", () => {
  const samples = [sample(1000), sample(5000), sample(11000), sample(15000)];
  const plateau = plateauSamples(samples, 10);
  assert.deepEqual(
    plateau.map((s) => s.timestamp),
    [11000, 15000],
  );
});

test("plateauSamples keeps everything when the ramp window would swallow the whole run", () => {
  const samples = [sample(1000), sample(2000)];
  assert.equal(plateauSamples(samples, 600).length, 2);
});

test("evaluateSla passes a round that meets every threshold", () => {
  const result = evaluateSla(overallFor(50, 100), { p95Ms: 500, errorPct: 1 });
  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test("evaluateSla reports each threshold that was breached", () => {
  const result = evaluateSla(overallFor(200, 100), { p95Ms: 500, errorPct: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.violations.length, 2);
  assert.match(result.violations[0], /p95 2500ms exceeds the 500ms threshold/);
  assert.match(result.violations[1], /error rate 10% exceeds the 1% threshold/);
});

test("evaluateSla only checks the thresholds that were set", () => {
  const result = evaluateSla(overallFor(200, 100), { errorPct: 50 });
  assert.equal(result.passed, true);
});

test("runSearchLoop brackets by doubling, then bisects onto the breaking point", async () => {
  const { loads, deps } = recorder({ breaksAbove: 136 });
  const outcome = await runSearchLoop(config(), { p95Ms: 500 }, deps);

  assert.deepEqual(loads, [50, 100, 200, 150, 125, 137, 131, 134]);
  assert.equal(outcome.breakingPoint, 137);
  assert.equal(outcome.lastHealthy, 134);
  assert.equal(outcome.stopReason, "converged");
  assert.match(outcome.conclusion, /134 threads met the SLA; 137 threads broke it/);
});

test("runSearchLoop labels the doubling rounds and the bisecting rounds differently", async () => {
  const { deps } = recorder({ breaksAbove: 136 });
  const outcome = await runSearchLoop(config(), { p95Ms: 500 }, deps);

  assert.deepEqual(
    outcome.iterations.slice(0, 3).map((i) => i.phase),
    ["bracketing", "bracketing", "bracketing"],
  );
  assert.equal(outcome.iterations[3].phase, "binary-search");
});

test("runSearchLoop records each round's load, execution and metrics", async () => {
  const { deps } = recorder({ breaksAbove: 136 });
  const outcome = await runSearchLoop(config({ maxIterations: 2 }), { p95Ms: 500 }, deps);

  const first = outcome.iterations[0];
  assert.equal(first.iteration, 1);
  assert.equal(first.numThreads, 50);
  assert.equal(first.rampTimeSeconds, 5);
  assert.equal(first.durationSeconds, 65);
  assert.equal(first.executionId, "exec_1");
  assert.equal(first.passed, true);
  assert.equal(first.metrics?.p95Ms, 200);
  assert.equal(first.metrics?.samples, 500);
});

test("runSearchLoop reports no breaking point when the ceiling itself holds", async () => {
  const { loads, deps } = recorder({ breaksAbove: 10000 });
  const outcome = await runSearchLoop(config({ maxThreads: 200 }), { p95Ms: 500 }, deps);

  assert.deepEqual(loads, [50, 100, 200]);
  assert.equal(outcome.breakingPoint, null);
  assert.equal(outcome.lastHealthy, 200);
  assert.equal(outcome.stopReason, "ceiling-reached");
  assert.match(outcome.conclusion, /No breaking point up to the 200-thread ceiling/);
});

test("runSearchLoop searches downward when even the first round breaks", async () => {
  const { loads, deps } = recorder({ breaksAbove: 0 });
  const outcome = await runSearchLoop(config(), { p95Ms: 500 }, deps);

  assert.equal(loads[0], 50);
  assert.ok(loads[1] < 50, `expected the second round to drop below 50, got ${loads[1]}`);
  assert.equal(outcome.lastHealthy, null);
  assert.match(outcome.conclusion, /no healthy load was established/);
});

test("runSearchLoop stops at maxIterations even without converging", async () => {
  const { loads, deps } = recorder({ breaksAbove: 136 });
  const outcome = await runSearchLoop(config({ maxIterations: 4 }), { p95Ms: 500 }, deps);

  assert.equal(loads.length, 4);
  assert.equal(outcome.stopReason, "max-iterations");
  assert.match(outcome.conclusion, /hit its 4-iteration limit/);
});

test("runSearchLoop honours a stop request and keeps the bounds found so far", async () => {
  const { loads, deps } = recorder({ breaksAbove: 136, stopAfter: 2 });
  const outcome = await runSearchLoop(config(), { p95Ms: 500 }, deps);

  assert.deepEqual(loads, [50, 100]);
  assert.equal(outcome.stopReason, "stopped");
  assert.equal(outcome.lastHealthy, 100);
  assert.equal(outcome.breakingPoint, null);
  assert.match(outcome.conclusion, /Stopped before any load violated the SLA/);
});

test("runSearchLoop cools down between rounds but not before the first", async () => {
  const { sleeps, deps } = recorder({ breaksAbove: 136 });
  await runSearchLoop(config({ maxIterations: 3, cooldownSeconds: 5 }), { p95Ms: 500 }, deps);
  assert.deepEqual(sleeps, [5000, 5000]);
});

test("runSearchLoop skips the cooldown entirely when it is zero", async () => {
  const { sleeps, deps } = recorder({ breaksAbove: 136 });
  await runSearchLoop(config({ maxIterations: 3, cooldownSeconds: 0 }), { p95Ms: 500 }, deps);
  assert.deepEqual(sleeps, []);
});

test("runSearchLoop refuses to call an empty round a breaking point", async () => {
  const { deps } = recorder({ breaksAbove: 136, emptyAt: 1 });
  await assert.rejects(
    () => runSearchLoop(config(), { p95Ms: 500 }, deps),
    /recorded no samples at all/,
  );
});

test("runSearchLoop reports the breaking point as a range when tolerance leaves levels untested", async () => {
  const { deps } = recorder({ breaksAbove: 3 });
  const outcome = await runSearchLoop(config({ startThreads: 2, maxThreads: 8, toleranceThreads: 2 }), { p95Ms: 500 }, deps);

  assert.equal(outcome.lastHealthy, 2);
  assert.equal(outcome.breakingPoint, 4);
  assert.deepEqual(outcome.breakingPointRange, { healthyUpTo: 2, brokenAt: 4, exact: false });
  assert.match(outcome.conclusion, /between 2 and 4 threads \(the 1 level in between was not tested\)/);
});

test("runSearchLoop marks the breaking point exact once the bounds are adjacent", async () => {
  const { deps } = recorder({ breaksAbove: 136 });
  const outcome = await runSearchLoop(config({ toleranceThreads: 1 }), { p95Ms: 500 }, deps);

  assert.equal(outcome.breakingPoint, 137);
  assert.deepEqual(outcome.breakingPointRange, { healthyUpTo: 136, brokenAt: 137, exact: true });
  assert.match(outcome.conclusion, /exactly 137 threads/);
});

test("runSearchLoop has no breaking point range while nothing has broken", async () => {
  const { deps } = recorder({ breaksAbove: 10000 });
  const outcome = await runSearchLoop(config({ maxThreads: 200 }), { p95Ms: 500 }, deps);
  assert.equal(outcome.breakingPointRange, null);
});

test("runSearchLoop records per-label metrics with each label's share of the round", async () => {
  const label = (name: string, count: number): LabelStats => ({ ...overallFor(50, 100), label: name, count });
  const deps: SearchDeps = {
    async runRound() {
      return { executionId: "exec_1", overall: overallFor(50, 100), byLabel: [label("login", 400), label("signup", 100)] };
    },
    async sleep() {},
    stopRequested: () => false,
    onProgress() {},
  };
  const outcome = await runSearchLoop(config({ maxIterations: 1 }), { p95Ms: 500 }, deps);

  const byLabel = outcome.iterations[0].metrics?.byLabel;
  assert.deepEqual(
    byLabel?.map((l) => [l.label, l.samples, l.sharePct]),
    [
      ["login", 400, 80],
      ["signup", 100, 20],
    ],
  );
});
