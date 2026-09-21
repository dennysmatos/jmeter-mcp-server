import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, callTool, expectToolError, type TestServer } from "./support/mcpClient.js";

let server: TestServer;
let planId: string;
let rootId: string;
let threadGroupId: string;
let samplerId: string;

before(async () => {
  server = await startServer();
  const plan = await callTool(server.client, "create_test_plan", { name: "Capacity" });
  planId = plan.planId;
  rootId = plan.rootNodeId;

  const tg = await callTool(server.client, "add_thread_group", {
    planId,
    parentId: rootId,
    name: "Users",
    numThreads: 5,
    rampTimeSeconds: 2,
    loops: 3,
  });
  threadGroupId = tg.nodeId;

  const sampler = await callTool(server.client, "add_http_sampler", {
    planId,
    parentId: threadGroupId,
    name: "Home",
    method: "GET",
    protocol: "https",
    domain: "example.org",
    path: "/",
  });
  samplerId = sampler.nodeId;
});

after(async () => {
  await server.close();
});

test("the capacity tools are exposed over stdio", async () => {
  const { tools } = await server.client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ["find_breaking_point", "get_breaking_point_status", "stop_breaking_point_search"]) {
    assert.ok(names.includes(name), `expected tool "${name}" to be registered; got: ${names.join(", ")}`);
  }
});

test("find_breaking_point refuses a plan with no listener to read metrics from", async () => {
  const message = await expectToolError(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId: threadGroupId,
    maxThreads: 100,
    p95Ms: 500,
  });
  assert.match(message, /no Aggregate Report, Summary Report, or View Results Tree listener/);
});

test("find_breaking_point refuses a node that is not a thread group", async () => {
  await callTool(server.client, "add_aggregate_report_listener", { planId, parentId: rootId });

  const message = await expectToolError(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId: samplerId,
    maxThreads: 100,
    p95Ms: 500,
  });
  assert.match(message, /is a HTTPSamplerProxy, not a thread group/);
});

test("find_breaking_point refuses an unknown node id", async () => {
  const message = await expectToolError(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId: "node_missing",
    maxThreads: 100,
    p95Ms: 500,
  });
  assert.match(message, /No node with id "node_missing" was found/);
});

test("find_breaking_point refuses an unknown plan", async () => {
  const message = await expectToolError(server.client, "find_breaking_point", {
    planId: "plan_missing",
    threadGroupNodeId: threadGroupId,
    maxThreads: 100,
    p95Ms: 500,
  });
  assert.match(message, /Test plan not found: plan_missing/);
});

test("find_breaking_point requires at least one SLA threshold", async () => {
  const message = await expectToolError(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId: threadGroupId,
    maxThreads: 100,
  });
  assert.match(message, /at least one SLA threshold/);
});

test("find_breaking_point refuses a startThreads above the ceiling", async () => {
  const message = await expectToolError(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId: threadGroupId,
    maxThreads: 20,
    startThreads: 50,
    p95Ms: 500,
  });
  assert.match(message, /startThreads \(50\) cannot exceed maxThreads \(20\)/);
});

test("find_breaking_point resolves the defaults it will search with", async () => {
  const started = await callTool(server.client, "find_breaking_point", {
    planId,
    threadGroupNodeId: threadGroupId,
    maxThreads: 500,
    p95Ms: 500,
    errorPct: 1,
  });

  assert.equal(started.status, "running");
  assert.match(started.searchId, /^search_/);
  assert.deepEqual(started.sla, { p95Ms: 500, errorPct: 1 });
  assert.equal(started.config.startThreads, 50);
  assert.equal(started.config.maxThreads, 500);
  assert.equal(started.config.toleranceThreads, 10);
  assert.equal(started.config.plateauDurationSeconds, 60);
  assert.equal(started.config.maxIterations, 8);

  await callTool(server.client, "stop_breaking_point_search", { searchId: started.searchId });
});

test("a search with no resolvable JMeter fails with its reason recorded", async () => {
  const noJmeter = await startServer({ withJmeterHome: false });
  try {
    const plan = await callTool(noJmeter.client, "create_test_plan", { name: "No JMeter" });
    const tg = await callTool(noJmeter.client, "add_thread_group", {
      planId: plan.planId,
      parentId: plan.rootNodeId,
      name: "Users",
      numThreads: 5,
      rampTimeSeconds: 2,
      loops: 3,
    });
    await callTool(noJmeter.client, "add_aggregate_report_listener", { planId: plan.planId, parentId: plan.rootNodeId });

    const { searchId } = await callTool(noJmeter.client, "find_breaking_point", {
      planId: plan.planId,
      threadGroupNodeId: tg.nodeId,
      maxThreads: 20,
      startThreads: 2,
      p95Ms: 500,
      cooldownSeconds: 0,
    });

    const deadline = Date.now() + 10000;
    let status = await callTool(noJmeter.client, "get_breaking_point_status", { searchId });
    while (status.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      status = await callTool(noJmeter.client, "get_breaking_point_status", { searchId });
    }

    assert.equal(status.status, "failed");
    assert.match(status.error, /JMETER_HOME/);

    // The thread group must come back exactly as it was authored, even on a failed search.
    const tree = await callTool(noJmeter.client, "get_test_plan", { planId: plan.planId });
    const group = tree.root.children.find((c: any) => c.id === tg.nodeId);
    assert.equal(status.propsRestored, true);
    assert.deepEqual(group.props, { numThreads: 5, rampTimeSeconds: 2, loops: 3 });
  } finally {
    await noJmeter.close();
  }
});

test("get_breaking_point_status rejects an unknown searchId", async () => {
  const message = await expectToolError(server.client, "get_breaking_point_status", { searchId: "search_nope" });
  assert.match(message, /Breaking point search not found: search_nope/);
});

test("stop_breaking_point_search reports a search that already ended", async () => {
  const noJmeter = await startServer({ withJmeterHome: false });
  try {
    const plan = await callTool(noJmeter.client, "create_test_plan", { name: "Already Done" });
    const tg = await callTool(noJmeter.client, "add_thread_group", {
      planId: plan.planId,
      parentId: plan.rootNodeId,
      name: "Users",
      numThreads: 1,
      rampTimeSeconds: 1,
      loops: 1,
    });
    await callTool(noJmeter.client, "add_aggregate_report_listener", { planId: plan.planId, parentId: plan.rootNodeId });

    const { searchId } = await callTool(noJmeter.client, "find_breaking_point", {
      planId: plan.planId,
      threadGroupNodeId: tg.nodeId,
      maxThreads: 10,
      startThreads: 2,
      p95Ms: 500,
      cooldownSeconds: 0,
    });

    const deadline = Date.now() + 10000;
    let status = await callTool(noJmeter.client, "get_breaking_point_status", { searchId });
    while (status.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      status = await callTool(noJmeter.client, "get_breaking_point_status", { searchId });
    }

    const stopped = await callTool(noJmeter.client, "stop_breaking_point_search", { searchId });
    assert.equal(stopped.stopped, false);
    assert.match(stopped.message, /already failed/);
  } finally {
    await noJmeter.close();
  }
});
