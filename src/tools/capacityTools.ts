import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULTS,
  describeSearch,
  readSearchMeta,
  startBreakingPointSearch,
  stopBreakingPointSearch,
} from "../execution/breakingPointSearch.js";
import { jsonResult } from "./shared.js";

export function registerCapacityTools(server: McpServer): void {
  server.registerTool(
    "find_breaking_point",
    {
      description:
        "Find the concurrency level where a test plan stops meeting its SLA. Runs the plan over and over on its own, " +
        "driving one thread group's thread count: first doubling the load until the SLA breaks, then binary-searching " +
        "between the last healthy level and the first broken one. Returns immediately with a searchId; poll " +
        "get_breaking_point_status for progress and the final breaking point. The thread group is temporarily switched " +
        "to ramp-up + fixed-plateau (scheduler) mode for the search and its original settings are restored when the " +
        "search ends. Requires an Aggregate Report, Summary Report, or View Results Tree listener in the plan. " +
        "Rounds always run the thread group in scheduler mode with an infinite loop count, so every thread repeats its " +
        "whole scenario until the plateau ends: a request meant to run once per user (e.g. a login) must sit under a " +
        "Once Only Controller, and a nested Loop Controller runs its count on every repeat. Each round reports its " +
        "metrics both overall and per label (byLabel, with each label's share of the samples) - check that the mix " +
        "matches what the plan intends. The SLA is judged on the overall numbers, not per label.",
      inputSchema: {
        planId: z.string(),
        threadGroupNodeId: z.string().describe("Node id of the thread group whose thread count the search will drive."),
        maxThreads: z.number().int().positive().describe("Safety ceiling - the search never runs more threads than this."),
        p95Ms: z.number().positive().optional().describe("Fail a round when overall p95 latency exceeds this many milliseconds."),
        errorPct: z.number().min(0).max(100).optional().describe("Fail a round when the overall error rate exceeds this percentage."),
        startThreads: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Thread count for the first round; doubles from there while the SLA holds (default ${DEFAULTS.startThreads}).`),
        toleranceThreads: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Stop bisecting once the healthy and broken bounds are this close (default: 2% of maxThreads, minimum 5)."),
        rampSecondsPerThread: z
          .number()
          .positive()
          .optional()
          .describe(`Ramp-up seconds per thread, so every round adds load at the same rate (default ${DEFAULTS.rampSecondsPerThread}).`),
        plateauDurationSeconds: z
          .number()
          .positive()
          .optional()
          .describe(`Seconds to hold full load after ramp-up; only these samples count toward the SLA (default ${DEFAULTS.plateauDurationSeconds}).`),
        cooldownSeconds: z
          .number()
          .min(0)
          .optional()
          .describe(`Pause between rounds so the system under test recovers (default ${DEFAULTS.cooldownSeconds}).`),
        maxIterations: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Hard cap on rounds, so a slow search still ends (default ${DEFAULTS.maxIterations}).`),
      },
    },
    (args) => jsonResult(startBreakingPointSearch(args)),
  );

  server.registerTool(
    "get_breaking_point_status",
    {
      description:
        "Check a capacity search started with find_breaking_point: status (running/completed/failed/stopped), " +
        "progress (rounds completed out of maxIterations, plus the in-flight round's elapsed time and percent " +
        "complete), the rounds run so far with each one's load and overall + per-label metrics, and - once it " +
        "finishes - the breaking point, the last healthy load, and a plain-language conclusion. breakingPoint is " +
        "the lowest load that was tested and broke the SLA, not necessarily the exact edge: read breakingPointRange " +
        "(healthyUpTo / brokenAt / exact) for the real precision, since levels between the two were never run when " +
        "toleranceThreads is above 1. There is no completion push - poll this tool. The same data is on disk at " +
        "files.meta, and each round's raw results are in files.executionsDir/<executionId>/.",
      inputSchema: {
        searchId: z.string(),
      },
    },
    ({ searchId }) => jsonResult(describeSearch(readSearchMeta(searchId))),
  );

  server.registerTool(
    "stop_breaking_point_search",
    {
      description:
        "Stop a running capacity search. Terminates the round in flight, restores the thread group's original " +
        "settings, and keeps whatever bounds the search had established so far.",
      inputSchema: {
        searchId: z.string(),
      },
    },
    ({ searchId }) => jsonResult(stopBreakingPointSearch(searchId)),
  );
}
