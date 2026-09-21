import { existsSync, statSync } from "node:fs";
import { computeAggregate, type LabelStats } from "./aggregate.js";
import { parseJtl, type SampleResult } from "./jtlParser.js";

/** The recent-throughput window: how far back from the newest sample "right now" reaches. */
const RECENT_WINDOW_MS = 10_000;

/** Reading the whole results file on every poll stops being cheap somewhere past this. */
const MAX_LIVE_BYTES = 200 * 1024 * 1024;

export interface LiveLabelProgress {
  label: string;
  samples: number;
  errorPct: number;
  p95Ms: number;
}

export interface LiveProgress {
  samples: number;
  errors: number;
  errorPct: number;
  avgMs: number;
  p95Ms: number;
  /** Samples per second averaged over the whole run so far. */
  throughputPerSec: number;
  /** Samples per second over the last few seconds - shows a run slowing down or speeding up. */
  recentThroughputPerSec: number;
  /** Seconds from the run's first sample to its latest one. */
  runSeconds: number;
  byLabel: LiveLabelProgress[];
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function liveProgressFrom(samples: SampleResult[]): LiveProgress | null {
  if (samples.length === 0) return null;
  const { overall, byLabel } = computeAggregate(samples);

  let firstStart = Infinity;
  let lastEnd = -Infinity;
  for (const sample of samples) {
    if (sample.timestamp < firstStart) firstStart = sample.timestamp;
    const end = sample.timestamp + sample.elapsed;
    if (end > lastEnd) lastEnd = end;
  }
  const windowStart = lastEnd - RECENT_WINDOW_MS;
  let recent = 0;
  for (const sample of samples) {
    if (sample.timestamp + sample.elapsed >= windowStart) recent++;
  }
  const windowSeconds = Math.max(1, Math.min(RECENT_WINDOW_MS, lastEnd - firstStart)) / 1000;

  return {
    samples: overall.count,
    errors: overall.errors,
    errorPct: round(overall.errorPct),
    avgMs: round(overall.avgMs),
    p95Ms: round(overall.p95Ms),
    throughputPerSec: round(overall.throughputPerSec),
    recentThroughputPerSec: round(recent / windowSeconds),
    runSeconds: Math.round((lastEnd - firstStart) / 1000),
    byLabel: byLabel.map((stats: LabelStats) => ({
      label: stats.label,
      samples: stats.count,
      errorPct: round(stats.errorPct),
      p95Ms: round(stats.p95Ms),
    })),
  };
}

/**
 * Numbers for a run that is still going, read from the results file JMeter is writing.
 * Returns a reason string instead of throwing so a status poll never fails over it.
 */
export function readLiveProgress(resultsFile: string | undefined): LiveProgress | { unavailable: string } {
  if (!resultsFile) return { unavailable: "The plan has no Aggregate Report, Summary Report, or View Results Tree listener." };
  if (!existsSync(resultsFile)) return { unavailable: "No samples written yet." };
  if (statSync(resultsFile).size > MAX_LIVE_BYTES) {
    return { unavailable: "The results file is too large to re-read on every poll; use get_execution_report once the run ends." };
  }
  try {
    return liveProgressFrom(parseJtl(resultsFile, { skipIncompleteTrailingRow: true })) ?? { unavailable: "No samples written yet." };
  } catch (err) {
    return { unavailable: `Could not read the results file yet: ${(err as Error).message}` };
  }
}
