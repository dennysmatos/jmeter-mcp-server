import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startServer, callTool, type TestServer } from "./support/mcpClient.js";
import { resolveJmeterBin } from "../src/jmeter.js";

function jmeterAvailable(): boolean {
  try {
    resolveJmeterBin();
    return true;
  } catch {
    return false;
  }
}

const skip = !jmeterAvailable();
const skipReason = "JMETER_HOME is not set/resolvable - run `npm run test:integration` with a real JMeter install";

/**
 * Concurrency this fake service handles before it falls over. Because every thread holds
 * exactly one request open at a time, in-flight requests track the thread count closely:
 * any round at or below CAPACITY threads stays fast, and the first round above it tips
 * into the slow path. That makes the breaking point a known number the search must find.
 */
const CAPACITY = 6;
const FAST_MS = 50;
const SLOW_MS = 2000;

let server: TestServer;
let target: Server;
let port: number;

before(async () => {
  if (skip) return;
  server = await startServer();

  let inflight = 0;
  target = createServer((_req, res) => {
    inflight++;
    const overloaded = inflight > CAPACITY;
    setTimeout(() => {
      inflight--;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    }, overloaded ? SLOW_MS : FAST_MS);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  port = (target.address() as any).port;
});

after(async () => {
  if (skip) return;
  await server.close();
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

async function buildPlan(name: string): Promise<{ planId: string; threadGroupNodeId: string }> {
  const { planId, rootNodeId } = await callTool(server.client, "create_test_plan", { name });
  const { nodeId: threadGroupNodeId } = await callTool(server.client, "add_thread_group", {
    planId,
    parentId: rootNodeId,
    name: "Load",
    numThreads: 1,
    rampTimeSeconds: 1,
    loops: 1,
  });
  await callTool(server.client, "add_http_sampler", {
    planId,
    parentId: threadGroupNodeId,
    name: "Home",
    method: "GET",
    protocol: "http",
    domain: "127.0.0.1",
    port,
    path: "/",
  });
  await callTool(server.client, "add_aggregate_report_listener", { planId, parentId: threadGroupNodeId });
  return { planId, threadGroupNodeId };
}

async function awaitSearch(searchId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let status = await callTool(server.client, "get_breaking_point_status", { searchId });
  while (status.status === "running") {
    if (Date.now() > deadline) {
      throw new Error(`Search ${searchId} did not finish within ${timeoutMs}ms (last status: ${JSON.stringify(status)})`);
    }
    await new Promise((r) => setTimeout(r, 250));
    status = await callTool(server.client, "get_breaking_point_status", { searchId });
  }
  return status;
}

test("find_breaking_point converges on the real concurrency limit of a live service", { skip: skip && skipReason }, async () => {
  const { planId, threadGroupNodeId } = await buildPlan("Breaking Point");

  const started = await callTool(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId,
    p95Ms: 500,
    startThreads: 4,
    maxThreads: 16,
    toleranceThreads: 1,
    rampSecondsPerThread: 0.1,
    plateauDurationSeconds: 3,
    cooldownSeconds: 0,
    maxIterations: 6,
  });
  assert.equal(started.status, "running");

  const result = await awaitSearch(started.searchId, 180000);
  assert.equal(result.status, "completed", `search failed: ${result.error}`);

  assert.equal(
    result.breakingPoint,
    CAPACITY + 1,
    `expected the first broken level to be ${CAPACITY + 1} threads, got ${result.breakingPoint}. Rounds: ` +
      JSON.stringify(result.iterations.map((i: any) => ({ n: i.numThreads, passed: i.passed, p95: i.metrics?.p95Ms }))),
  );
  assert.equal(result.lastHealthy, CAPACITY);
  assert.equal(result.stopReason, "converged");

  // Every round actually ran JMeter and produced samples to judge.
  for (const iteration of result.iterations) {
    assert.ok(iteration.executionId, `iteration ${iteration.iteration} has no executionId`);
    assert.ok(iteration.metrics.samples > 0, `iteration ${iteration.iteration} recorded no samples`);
  }

  // Healthy rounds sit near FAST_MS; the broken one is dragged up by the slow path.
  const healthy = result.iterations.find((i: any) => i.numThreads === CAPACITY);
  const broken = result.iterations.find((i: any) => i.numThreads === CAPACITY + 1);
  assert.ok(healthy.passed, "the round at capacity should have met the SLA");
  assert.ok(!broken.passed, "the round just above capacity should have violated the SLA");
  assert.ok(broken.metrics.p95Ms > healthy.metrics.p95Ms * 2, "the broken round should show a clear p95 jump");
});

test("find_breaking_point restores the thread group it drove", { skip: skip && skipReason }, async () => {
  const { planId, threadGroupNodeId } = await buildPlan("Restore Props");
  const before = await callTool(server.client, "get_test_plan", { planId });
  const originalProps = before.root.children[0].props;

  const { searchId } = await callTool(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId,
    p95Ms: 500,
    startThreads: 2,
    maxThreads: 2,
    plateauDurationSeconds: 2,
    cooldownSeconds: 0,
    maxIterations: 1,
  });
  const result = await awaitSearch(searchId, 90000);
  assert.equal(result.status, "completed", `search failed: ${result.error}`);
  assert.equal(result.propsRestored, true);

  const after = await callTool(server.client, "get_test_plan", { planId });
  assert.deepEqual(after.root.children[0].props, originalProps);
  assert.deepEqual(originalProps, { numThreads: 1, rampTimeSeconds: 1, loops: 1 });
});

test("a search with no breaking point below the ceiling says so", { skip: skip && skipReason }, async () => {
  const { planId, threadGroupNodeId } = await buildPlan("No Breaking Point");

  const { searchId } = await callTool(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId,
    p95Ms: 500,
    startThreads: 2,
    maxThreads: 4,
    plateauDurationSeconds: 2,
    cooldownSeconds: 0,
    maxIterations: 4,
  });
  const result = await awaitSearch(searchId, 120000);

  assert.equal(result.status, "completed", `search failed: ${result.error}`);
  assert.equal(result.breakingPoint, null);
  assert.equal(result.lastHealthy, 4);
  assert.equal(result.stopReason, "ceiling-reached");
  assert.match(result.conclusion, /No breaking point up to the 4-thread ceiling/);
});

test("stop_breaking_point_search halts a live search and restores the plan", { skip: skip && skipReason }, async () => {
  const { planId, threadGroupNodeId } = await buildPlan("Stop Search");

  const { searchId } = await callTool(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId,
    p95Ms: 500,
    startThreads: 2,
    maxThreads: 64,
    plateauDurationSeconds: 30,
    cooldownSeconds: 0,
    maxIterations: 8,
  });

  // Wait until a round is genuinely in flight before pulling the plug.
  const deadline = Date.now() + 60000;
  let status = await callTool(server.client, "get_breaking_point_status", { searchId });
  while (!status.currentExecutionId && status.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    status = await callTool(server.client, "get_breaking_point_status", { searchId });
  }
  assert.ok(status.currentExecutionId, "expected a round to be in flight to stop");

  const stopped = await callTool(server.client, "stop_breaking_point_search", { searchId });
  assert.equal(stopped.stopped, true);

  const result = await awaitSearch(searchId, 60000);
  assert.equal(result.status, "stopped", `expected status "stopped", got "${result.status}" (${result.error ?? "no error"})`);
  assert.equal(result.stopReason, "stopped");
  assert.equal(result.propsRestored, true);

  const after = await callTool(server.client, "get_test_plan", { planId });
  assert.deepEqual(after.root.children[0].props, { numThreads: 1, rampTimeSeconds: 1, loops: 1 });
});
