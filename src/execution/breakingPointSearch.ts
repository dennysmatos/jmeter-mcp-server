import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findNode } from "../jmx/tree.js";
import type { NodeType, TestNode } from "../jmx/types.js";
import { computeAggregate, type AggregateReport, type LabelStats } from "../report/aggregate.js";
import { parseJtl, type SampleResult } from "../report/jtlParser.js";
import { capacitySearchDir, executionsDir, newCapacitySearchId, readPlan, writePlan } from "../workspace.js";
import { planGroovyWarning } from "../jsr223Compat.js";
import { hasNodeOfType, readMeta, startExecution, stopExecution, tailLog } from "./processManager.js";

/** Thread group flavours whose numThreads/rampTime the search is allowed to drive. */
const THREAD_GROUP_TYPES: NodeType[] = ["ThreadGroup", "SetupThreadGroup", "PostThreadGroup"];

export const DEFAULTS = {
  startThreads: 50,
  rampSecondsPerThread: 0.1,
  plateauDurationSeconds: 60,
  cooldownSeconds: 5,
  maxIterations: 8,
} as const;

/** Extra wall-clock slack on top of a round's own duration before we call the round hung. */
const ROUND_GRACE_SECONDS = 120;
const POLL_INTERVAL_MS = 500;

export type SearchStatus = "running" | "completed" | "failed" | "stopped";
export type SearchPhase = "bracketing" | "binary-search";

/**
 * A round passes only when every threshold the caller set is met. Both are optional
 * individually, but find_breaking_point rejects a request that sets neither - with no
 * threshold there is nothing for the search to converge on.
 */
export interface SlaThresholds {
  p95Ms?: number;
  errorPct?: number;
}

export interface RoundLoad {
  numThreads: number;
  rampTimeSeconds: number;
  durationSeconds: number;
}

/** One label's slice of a round, so a skewed request mix shows up next to the overall numbers. */
export interface LabelMetrics {
  label: string;
  samples: number;
  /** Share of the round's samples that this label accounts for. */
  sharePct: number;
  errorPct: number;
  avgMs: number;
  p95Ms: number;
}

export interface RoundMetrics {
  samples: number;
  errorPct: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  throughputPerSec: number;
  byLabel: LabelMetrics[];
}

export interface SearchIteration extends RoundLoad {
  iteration: number;
  phase: SearchPhase;
  executionId: string | null;
  passed: boolean;
  violations: string[];
  metrics: RoundMetrics | null;
}

/** What the search knows so far: the best load that held, and the lowest that broke. */
export interface SearchBounds {
  /** Highest load that met the SLA; 0 while no round has passed. */
  lo: number;
  /** Lowest load that violated the SLA; null while still bracketing upward. */
  hi: number | null;
}

export type StopReason = "converged" | "ceiling-reached" | "max-iterations" | "stopped";

export interface ResolvedConfig {
  startThreads: number;
  maxThreads: number;
  toleranceThreads: number;
  rampSecondsPerThread: number;
  plateauDurationSeconds: number;
  cooldownSeconds: number;
  maxIterations: number;
}

export interface SearchMeta {
  searchId: string;
  planId: string;
  threadGroupNodeId: string;
  threadGroupName: string;
  status: SearchStatus;
  startTime: string;
  endTime?: string;
  sla: SlaThresholds;
  config: ResolvedConfig;
  /** The thread group's own props, saved so the search can put them back when it ends. */
  originalProps: Record<string, unknown>;
  propsRestored: boolean;
  currentLoad?: RoundLoad;
  currentRoundStartTime?: string;
  currentExecutionId?: string;
  iterations: SearchIteration[];
  bounds: SearchBounds;
  /** Lowest load that was *tested* and broke the SLA. See breakingPointRange for how precise that is. */
  breakingPoint: number | null;
  lastHealthy: number | null;
  breakingPointRange: BreakingPointRange | null;
  stopReason?: StopReason;
  conclusion?: string;
  error?: string;
}

/**
 * Where the true edge lies. The search only tests some loads, so with a tolerance above 1 the
 * levels between `healthyUpTo` and `brokenAt` were never run: the real breaking point is
 * somewhere in (healthyUpTo, brokenAt]. `exact` is true only when the two are adjacent.
 */
export interface BreakingPointRange {
  healthyUpTo: number | null;
  brokenAt: number;
  exact: boolean;
}

export function breakingPointRange(bounds: SearchBounds): BreakingPointRange | null {
  if (bounds.hi === null) return null;
  return {
    healthyUpTo: bounds.lo === 0 ? null : bounds.lo,
    brokenAt: bounds.hi,
    exact: bounds.lo !== 0 && bounds.hi - bounds.lo === 1,
  };
}

/** Thrown when a stop request interrupts a round; converts to status "stopped", not "failed". */
class SearchStopped extends Error {
  constructor() {
    super("Search stopped by request.");
    this.name = "SearchStopped";
  }
}

export function defaultTolerance(maxThreads: number): number {
  return Math.max(5, Math.round(maxThreads * 0.02));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Decides the load for the next round, or null when the search is done.
 *
 * While `hi` is null we're bracketing: start at `startThreads` and double until a round
 * breaks or we hit the ceiling. Once something has broken we bisect `(lo, hi)` until the
 * gap fits inside `toleranceThreads` - or until the midpoint is no longer strictly
 * between the bounds, which is the integer-arithmetic end of the road.
 */
export function nextLoad(bounds: SearchBounds, cfg: Pick<ResolvedConfig, "startThreads" | "maxThreads" | "toleranceThreads">): number | null {
  const { lo, hi } = bounds;
  if (hi === null) {
    if (lo === 0) return Math.max(1, Math.min(cfg.startThreads, cfg.maxThreads));
    if (lo >= cfg.maxThreads) return null;
    return Math.min(lo * 2, cfg.maxThreads);
  }
  if (hi - lo <= cfg.toleranceThreads) return null;
  const mid = Math.floor((lo + hi) / 2);
  if (mid <= lo || mid >= hi) return null;
  return mid;
}

/** Ramp-up scales with the load so every round pushes threads in at the same rate. */
export function roundLoadFor(numThreads: number, cfg: Pick<ResolvedConfig, "rampSecondsPerThread" | "plateauDurationSeconds">): RoundLoad {
  const rampTimeSeconds = Math.max(1, Math.ceil(numThreads * cfg.rampSecondsPerThread));
  return { numThreads, rampTimeSeconds, durationSeconds: rampTimeSeconds + cfg.plateauDurationSeconds };
}

/**
 * Keeps only the samples that started after the ramp-up window closed, so a round's
 * numbers describe steady state at N threads rather than the climb up to it. Falls back
 * to the full set when the filter would leave nothing to measure.
 */
export function plateauSamples(samples: SampleResult[], rampTimeSeconds: number): SampleResult[] {
  if (samples.length === 0 || rampTimeSeconds <= 0) return samples;
  let firstTimestamp = Infinity;
  for (const sample of samples) {
    if (sample.timestamp < firstTimestamp) firstTimestamp = sample.timestamp;
  }
  const cutoff = firstTimestamp + rampTimeSeconds * 1000;
  const plateau = samples.filter((sample) => sample.timestamp >= cutoff);
  return plateau.length > 0 ? plateau : samples;
}

export function evaluateSla(overall: LabelStats, sla: SlaThresholds): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  if (sla.p95Ms !== undefined && overall.p95Ms > sla.p95Ms) {
    violations.push(`p95 ${round(overall.p95Ms)}ms exceeds the ${sla.p95Ms}ms threshold`);
  }
  if (sla.errorPct !== undefined && overall.errorPct > sla.errorPct) {
    violations.push(`error rate ${round(overall.errorPct)}% exceeds the ${sla.errorPct}% threshold`);
  }
  return { passed: violations.length === 0, violations };
}

function metricsFrom(overall: LabelStats, byLabel: LabelStats[] = []): RoundMetrics {
  return {
    samples: overall.count,
    errorPct: round(overall.errorPct),
    avgMs: round(overall.avgMs),
    p95Ms: round(overall.p95Ms),
    p99Ms: round(overall.p99Ms),
    throughputPerSec: round(overall.throughputPerSec),
    byLabel: byLabel.map((stats) => ({
      label: stats.label,
      samples: stats.count,
      sharePct: round(overall.count === 0 ? 0 : (stats.count / overall.count) * 100),
      errorPct: round(stats.errorPct),
      avgMs: round(stats.avgMs),
      p95Ms: round(stats.p95Ms),
    })),
  };
}

export interface RoundResult {
  executionId: string | null;
  overall: LabelStats | null;
  byLabel?: LabelStats[];
}

export interface SearchDeps {
  /** Applies the load, runs it for real, and returns the plateau-only aggregate. */
  runRound(load: RoundLoad, iteration: number): Promise<RoundResult>;
  sleep(ms: number): Promise<void>;
  stopRequested(): boolean;
  /** Called after every round so the caller can persist progress mid-search. */
  onProgress(update: { iteration: SearchIteration; bounds: SearchBounds }): void;
  /** Called before a round starts, so an in-flight round is visible to pollers. */
  onRoundStart?(load: RoundLoad, iteration: number): void;
}

export interface SearchOutcome {
  iterations: SearchIteration[];
  bounds: SearchBounds;
  breakingPoint: number | null;
  lastHealthy: number | null;
  breakingPointRange: BreakingPointRange | null;
  stopReason: StopReason;
  conclusion: string;
}

function conclude(bounds: SearchBounds, stopReason: StopReason, cfg: ResolvedConfig): string {
  const { lo, hi } = bounds;
  if (stopReason === "stopped") {
    return hi === null
      ? `Stopped before any load violated the SLA; the highest level confirmed healthy was ${lo || "none"}.`
      : `Stopped mid-search. So far ${hi} threads violated the SLA and ${lo || "no level"} held.`;
  }
  if (hi === null) {
    return lo >= cfg.maxThreads
      ? `No breaking point up to the ${cfg.maxThreads}-thread ceiling - ${lo} threads still met the SLA. Raise maxThreads to keep looking.`
      : `No breaking point found within ${cfg.maxIterations} iterations; ${lo} threads still met the SLA.`;
  }
  if (lo === 0) {
    return `Even the lowest level tried (${hi} threads) violated the SLA, so no healthy load was established. Lower startThreads to find one.`;
  }
  const suffix =
    stopReason === "max-iterations"
      ? ` Search hit its ${cfg.maxIterations}-iteration limit, so the true edge is somewhere in that ${hi - lo}-thread window.`
      : ` Bounds converged to within ${hi - lo} threads (tolerance ${cfg.toleranceThreads}).`;
  const untested = hi - lo - 1;
  const edge =
    untested > 0
      ? ` The breaking point is between ${lo} and ${hi} threads (the ${untested} level${untested === 1 ? "" : "s"} in between ${untested === 1 ? "was" : "were"} not tested), not exactly ${hi}.`
      : ` The breaking point is exactly ${hi} threads.`;
  return `${lo} threads met the SLA; ${hi} threads broke it.${suffix}${edge}`;
}

/**
 * The search itself, with every side effect behind `deps` so it can be driven
 * round-by-round in tests without JMeter or a system under test.
 */
export async function runSearchLoop(cfg: ResolvedConfig, sla: SlaThresholds, deps: SearchDeps): Promise<SearchOutcome> {
  let bounds: SearchBounds = { lo: 0, hi: null };
  const iterations: SearchIteration[] = [];
  let stopped = false;

  let load = nextLoad(bounds, cfg);
  while (load !== null && iterations.length < cfg.maxIterations) {
    if (deps.stopRequested()) {
      stopped = true;
      break;
    }
    if (iterations.length > 0 && cfg.cooldownSeconds > 0) {
      await deps.sleep(cfg.cooldownSeconds * 1000);
      if (deps.stopRequested()) {
        stopped = true;
        break;
      }
    }

    const phase: SearchPhase = bounds.hi === null ? "bracketing" : "binary-search";
    const shape = roundLoadFor(load, cfg);
    const iterationNumber = iterations.length + 1;
    deps.onRoundStart?.(shape, iterationNumber);

    let result: RoundResult;
    try {
      result = await deps.runRound(shape, iterationNumber);
    } catch (err) {
      if (err instanceof SearchStopped || deps.stopRequested()) {
        stopped = true;
        break;
      }
      throw err;
    }

    if (!result.overall || result.overall.count === 0) {
      throw new Error(
        `Round ${iterationNumber} at ${load} threads recorded no samples at all. That points at the test plan or the ` +
          `target being unreachable rather than a capacity limit, so the search stopped instead of reporting ${load} ` +
          `as a breaking point. Run the plan once with execute_test_plan to check it produces results.`,
      );
    }

    const { passed, violations } = evaluateSla(result.overall, sla);
    const iteration: SearchIteration = {
      iteration: iterationNumber,
      phase,
      ...shape,
      executionId: result.executionId,
      passed,
      violations,
      metrics: metricsFrom(result.overall, result.byLabel),
    };
    iterations.push(iteration);
    bounds = passed ? { lo: load, hi: bounds.hi } : { lo: bounds.lo, hi: load };
    deps.onProgress({ iteration, bounds });

    load = nextLoad(bounds, cfg);
  }

  let stopReason: StopReason;
  if (stopped) {
    stopReason = "stopped";
  } else if (iterations.length >= cfg.maxIterations && load !== null) {
    stopReason = "max-iterations";
  } else if (bounds.hi === null) {
    stopReason = "ceiling-reached";
  } else {
    stopReason = "converged";
  }

  return {
    iterations,
    bounds,
    breakingPoint: bounds.hi,
    lastHealthy: bounds.lo === 0 ? null : bounds.lo,
    breakingPointRange: breakingPointRange(bounds),
    stopReason,
    conclusion: conclude(bounds, stopReason, cfg),
  };
}

export function metaPath(searchId: string): string {
  return path.join(capacitySearchDir(searchId), "meta.json");
}

function writeSearchMeta(meta: SearchMeta): void {
  writeFileSync(metaPath(meta.searchId), JSON.stringify(meta, null, 2), "utf-8");
}

export function readSearchMeta(searchId: string): SearchMeta {
  const file = metaPath(searchId);
  if (!existsSync(file)) {
    throw new Error(`Breaking point search not found: ${searchId}`);
  }
  return JSON.parse(readFileSync(file, "utf-8")) as SearchMeta;
}

const stopRequests = new Set<string>();

export interface BreakingPointRequest {
  planId: string;
  threadGroupNodeId: string;
  maxThreads: number;
  p95Ms?: number;
  errorPct?: number;
  startThreads?: number;
  toleranceThreads?: number;
  rampSecondsPerThread?: number;
  plateauDurationSeconds?: number;
  cooldownSeconds?: number;
  maxIterations?: number;
}

/**
 * Writes the round's load onto the thread group and runs the plan. The thread group is
 * forced into scheduler mode (duration, loops cleared) so every round is a ramp plus a
 * fixed plateau - loop counts would make rounds at different thread counts incomparable.
 */
function applyLoad(planId: string, nodeId: string, load: RoundLoad): void {
  const plan = readPlan(planId);
  const node = findNode(plan.root, nodeId);
  if (!node) {
    throw new Error(`Thread group ${nodeId} disappeared from plan ${planId} while the search was running.`);
  }
  node.props = {
    ...node.props,
    numThreads: load.numThreads,
    rampTimeSeconds: load.rampTimeSeconds,
    durationSeconds: load.durationSeconds,
  };
  delete node.props.loops;
  // A start delay would eat into the round's fixed ramp + plateau window.
  delete node.props.delaySeconds;
  writePlan(plan);
}

function restoreProps(planId: string, nodeId: string, originalProps: Record<string, unknown>): boolean {
  try {
    const plan = readPlan(planId);
    const node = findNode(plan.root, nodeId);
    if (!node) return false;
    node.props = { ...originalProps };
    writePlan(plan);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExecution(executionId: string, deadlineMs: number, searchId: string): Promise<void> {
  for (;;) {
    const meta = readMeta(executionId);
    if (meta.status !== "running") {
      if (meta.status === "failed") {
        if (stopRequests.has(searchId)) throw new SearchStopped();
        throw new Error(`JMeter exited with code ${meta.exitCode} during the search. Log tail:\n${tailLog(executionId)}`);
      }
      return;
    }
    if (stopRequests.has(searchId)) {
      stopExecution(executionId);
      throw new SearchStopped();
    }
    if (Date.now() > deadlineMs) {
      stopExecution(executionId);
      throw new Error(
        `Round ${executionId} was still running ${ROUND_GRACE_SECONDS}s past its scheduled duration, so the search gave up on it.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function readPlateauAggregate(executionId: string, rampTimeSeconds: number): AggregateReport | null {
  const meta = readMeta(executionId);
  const sourceFile = meta.aggregateFilename ?? meta.summaryFilename ?? meta.viewResultsTreeFilename;
  if (!sourceFile || !existsSync(sourceFile)) return null;
  const samples = parseJtl(sourceFile);
  if (samples.length === 0) return null;
  return computeAggregate(plateauSamples(samples, rampTimeSeconds));
}

export interface SearchProgress {
  roundsCompleted: number;
  maxIterations: number;
  elapsedSeconds: number;
  /** Present only while a round is in flight. */
  currentRound?: {
    iteration: number;
    numThreads: number;
    elapsedSeconds: number;
    plannedSeconds: number;
    percentComplete: number;
  };
}

/** What get_breaking_point_status adds on top of the stored meta: progress and where the files live. */
export function describeSearch(meta: SearchMeta): SearchMeta & { progress: SearchProgress; files: { meta: string; executionsDir: string } } {
  const end = meta.endTime ? Date.parse(meta.endTime) : Date.now();
  const progress: SearchProgress = {
    roundsCompleted: meta.iterations.length,
    maxIterations: meta.config.maxIterations,
    elapsedSeconds: Math.max(0, Math.round((end - Date.parse(meta.startTime)) / 1000)),
  };
  if (meta.currentLoad && meta.currentRoundStartTime) {
    const elapsed = Math.max(0, (Date.now() - Date.parse(meta.currentRoundStartTime)) / 1000);
    progress.currentRound = {
      iteration: meta.iterations.length + 1,
      numThreads: meta.currentLoad.numThreads,
      elapsedSeconds: Math.round(elapsed),
      plannedSeconds: meta.currentLoad.durationSeconds,
      percentComplete: Math.min(100, Math.round((elapsed / meta.currentLoad.durationSeconds) * 100)),
    };
  }
  return { ...meta, progress, files: { meta: metaPath(meta.searchId), executionsDir: executionsDir() } };
}

export function startBreakingPointSearch(request: BreakingPointRequest): {
  searchId: string;
  status: SearchStatus;
  config: ResolvedConfig;
  sla: SlaThresholds;
  statusFile: string;
  warnings?: string[];
} {
  const sla: SlaThresholds = {};
  if (request.p95Ms !== undefined) sla.p95Ms = request.p95Ms;
  if (request.errorPct !== undefined) sla.errorPct = request.errorPct;
  if (sla.p95Ms === undefined && sla.errorPct === undefined) {
    throw new Error("Set at least one SLA threshold (p95Ms and/or errorPct) - the search needs something to converge on.");
  }

  const plan = readPlan(request.planId);
  const node = findNode(plan.root, request.threadGroupNodeId);
  if (!node) {
    throw new Error(`No node with id "${request.threadGroupNodeId}" was found in this test plan.`);
  }
  if (!THREAD_GROUP_TYPES.includes(node.type)) {
    throw new Error(
      `Node "${request.threadGroupNodeId}" is a ${node.type}, not a thread group. find_breaking_point drives thread ` +
        `count, so it needs one of: ${THREAD_GROUP_TYPES.join(", ")}.`,
    );
  }
  const hasListener =
    hasNodeOfType(plan.root, "ResultCollectorAggregate") ||
    hasNodeOfType(plan.root, "ResultCollectorSummary") ||
    hasNodeOfType(plan.root, "ResultCollectorViewResultsTree");
  if (!hasListener) {
    throw new Error(
      "This test plan has no Aggregate Report, Summary Report, or View Results Tree listener, so the search would have " +
        "no metrics to judge the SLA against. Add one with add_aggregate_report_listener before searching.",
    );
  }

  const startThreads = request.startThreads ?? DEFAULTS.startThreads;
  if (request.maxThreads < 1) {
    throw new Error("maxThreads must be at least 1.");
  }
  if (startThreads > request.maxThreads) {
    throw new Error(`startThreads (${startThreads}) cannot exceed maxThreads (${request.maxThreads}).`);
  }

  const config: ResolvedConfig = {
    startThreads,
    maxThreads: request.maxThreads,
    toleranceThreads: request.toleranceThreads ?? defaultTolerance(request.maxThreads),
    rampSecondsPerThread: request.rampSecondsPerThread ?? DEFAULTS.rampSecondsPerThread,
    plateauDurationSeconds: request.plateauDurationSeconds ?? DEFAULTS.plateauDurationSeconds,
    cooldownSeconds: request.cooldownSeconds ?? DEFAULTS.cooldownSeconds,
    maxIterations: request.maxIterations ?? DEFAULTS.maxIterations,
  };

  const searchId = newCapacitySearchId();
  const meta: SearchMeta = {
    searchId,
    planId: request.planId,
    threadGroupNodeId: request.threadGroupNodeId,
    threadGroupName: node.name,
    status: "running",
    startTime: new Date().toISOString(),
    sla,
    config,
    originalProps: { ...node.props },
    propsRestored: false,
    iterations: [],
    bounds: { lo: 0, hi: null },
    breakingPoint: null,
    lastHealthy: null,
    breakingPointRange: null,
  };
  writeSearchMeta(meta);

  void driveSearch(searchId);

  const groovyWarning = planGroovyWarning(plan.root);
  return { searchId, status: "running", config, sla, statusFile: metaPath(searchId), ...(groovyWarning && { warnings: [groovyWarning] }) };
}

async function driveSearch(searchId: string): Promise<void> {
  const initial = readSearchMeta(searchId);
  const { planId, threadGroupNodeId, config, sla, originalProps } = initial;

  const deps: SearchDeps = {
    sleep,
    stopRequested: () => stopRequests.has(searchId),
    onRoundStart(load) {
      const meta = readSearchMeta(searchId);
      meta.currentLoad = load;
      meta.currentRoundStartTime = new Date().toISOString();
      delete meta.currentExecutionId;
      writeSearchMeta(meta);
    },
    onProgress({ iteration, bounds }) {
      const meta = readSearchMeta(searchId);
      meta.iterations.push(iteration);
      meta.bounds = bounds;
      meta.breakingPoint = bounds.hi;
      meta.lastHealthy = bounds.lo === 0 ? null : bounds.lo;
      meta.breakingPointRange = breakingPointRange(bounds);
      delete meta.currentLoad;
      delete meta.currentRoundStartTime;
      delete meta.currentExecutionId;
      writeSearchMeta(meta);
    },
    async runRound(load) {
      applyLoad(planId, threadGroupNodeId, load);
      const { executionId } = startExecution(planId);
      const meta = readSearchMeta(searchId);
      meta.currentExecutionId = executionId;
      writeSearchMeta(meta);
      await waitForExecution(executionId, Date.now() + (load.durationSeconds + ROUND_GRACE_SECONDS) * 1000, searchId);
      const aggregate = readPlateauAggregate(executionId, load.rampTimeSeconds);
      return { executionId, overall: aggregate?.overall ?? null, byLabel: aggregate?.byLabel };
    },
  };

  try {
    const outcome = await runSearchLoop(config, sla, deps);
    const meta = readSearchMeta(searchId);
    meta.status = outcome.stopReason === "stopped" ? "stopped" : "completed";
    meta.bounds = outcome.bounds;
    meta.breakingPoint = outcome.breakingPoint;
    meta.lastHealthy = outcome.lastHealthy;
    meta.breakingPointRange = outcome.breakingPointRange;
    meta.stopReason = outcome.stopReason;
    meta.conclusion = outcome.conclusion;
    meta.endTime = new Date().toISOString();
    delete meta.currentLoad;
    delete meta.currentRoundStartTime;
    delete meta.currentExecutionId;
    meta.propsRestored = restoreProps(planId, threadGroupNodeId, originalProps);
    writeSearchMeta(meta);
  } catch (err) {
    const meta = readSearchMeta(searchId);
    meta.status = "failed";
    meta.error = (err as Error).message;
    meta.endTime = new Date().toISOString();
    delete meta.currentLoad;
    delete meta.currentRoundStartTime;
    delete meta.currentExecutionId;
    meta.propsRestored = restoreProps(planId, threadGroupNodeId, originalProps);
    writeSearchMeta(meta);
  } finally {
    stopRequests.delete(searchId);
  }
}

export function stopBreakingPointSearch(searchId: string): { stopped: boolean; message: string } {
  const meta = readSearchMeta(searchId);
  if (meta.status !== "running") {
    return { stopped: false, message: `Search is already ${meta.status}.` };
  }
  stopRequests.add(searchId);
  if (meta.currentExecutionId) {
    const result = stopExecution(meta.currentExecutionId);
    return {
      stopped: true,
      message: result.stopped
        ? `Stop requested; terminated the in-flight round (${meta.currentExecutionId}). Poll get_breaking_point_status for the partial result.`
        : `Stop requested, but the in-flight round could not be terminated: ${result.message}`,
    };
  }
  return { stopped: true, message: "Stop requested; the search will end before its next round." };
}
