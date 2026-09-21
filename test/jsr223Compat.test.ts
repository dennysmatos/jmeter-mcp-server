import { test } from "node:test";
import assert from "node:assert/strict";
import { assessGroovyCompat, detectRuntime, parseGroovyVersion, parseJavaMajor, planUsesGroovy } from "../src/jsr223Compat.js";
import { createNode, addChild } from "../src/jmx/tree.js";
import { startServer, callTool } from "./support/mcpClient.js";

test("parseJavaMajor reads modern and legacy version strings", () => {
  assert.equal(parseJavaMajor('java version "26.0.1" 2026-04-21\nJava(TM) SE Runtime Environment'), 26);
  assert.equal(parseJavaMajor('openjdk version "17.0.10" 2024-01-16'), 17);
  assert.equal(parseJavaMajor('openjdk version "21" 2023-09-19'), 21);
  assert.equal(parseJavaMajor('java version "1.8.0_402"'), 8);
  assert.equal(parseJavaMajor("command not found"), null);
});

test("parseGroovyVersion finds the core groovy jar and ignores the modules", () => {
  assert.equal(parseGroovyVersion(["groovy-json-3.0.20.jar", "groovy-3.0.20.jar", "groovy-sql-3.0.20.jar"]), "3.0.20");
  assert.equal(parseGroovyVersion(["commons-io-2.15.jar"]), null);
});

test("assessGroovyCompat warns on a Java newer than Groovy supports, and says what to do", () => {
  const warning = assessGroovyCompat({ javaMajor: 26, groovyVersion: "3.0.20" });
  assert.ok(warning);
  assert.match(warning, /Java 26/);
  assert.match(warning, /Groovy 3\.0\.20/);
  assert.match(warning, /__UUID/);
  assert.match(warning, /JAVA_HOME/);
  assert.match(warning, /Java 17/);
});

test("assessGroovyCompat stays quiet for supported Java and for an unreadable environment", () => {
  assert.equal(assessGroovyCompat({ javaMajor: 17, groovyVersion: "3.0.20" }), null);
  assert.equal(assessGroovyCompat({ javaMajor: 21, groovyVersion: "3.0.20" }), null);
  assert.equal(assessGroovyCompat({ javaMajor: null, groovyVersion: null }), null);
});

test("planUsesGroovy finds Groovy JSR223 anywhere in the tree but not other script languages", () => {
  const root = createNode("TestPlan", "Plan", {});
  const group = createNode("ThreadGroup", "Users", { numThreads: 1, rampTimeSeconds: 1, loops: 1 });
  addChild(root, root.id, group);
  assert.equal(planUsesGroovy(root), false);

  addChild(root, group.id, createNode("JSR223PreProcessor", "js", { scriptLanguage: "javascript", script: "" }));
  assert.equal(planUsesGroovy(root), false);

  addChild(root, group.id, createNode("JSR223PreProcessor", "groovy", { scriptLanguage: "groovy", script: "" }));
  assert.equal(planUsesGroovy(root), true);
});

test("detectRuntime reads this machine's Java and JMeter's Groovy without throwing", () => {
  const runtime = detectRuntime();
  assert.ok(runtime.javaMajor === null || runtime.javaMajor >= 8);
});

test("the JSR223 tools warn through the real server exactly when this machine's Java is too new", async () => {
  const runtime = detectRuntime();
  const expectWarning = assessGroovyCompat(runtime) !== null;
  const server = await startServer();
  try {
    const { planId, rootNodeId } = await callTool(server.client, "create_test_plan", { name: "Groovy" });
    const { nodeId: tg } = await callTool(server.client, "add_thread_group", {
      planId,
      parentId: rootNodeId,
      name: "Users",
      numThreads: 1,
      rampTimeSeconds: 1,
      loops: 1,
    });
    const groovy = await callTool(server.client, "add_jsr223_preprocessor", { planId, parentId: tg, script: "vars.put('a','b')" });
    assert.equal(typeof groovy.warning === "string", expectWarning);

    const js = await callTool(server.client, "add_jsr223_preprocessor", {
      planId,
      parentId: tg,
      scriptLanguage: "javascript",
      script: "1",
    });
    assert.equal(js.warning, undefined, "non-Groovy scripts don't run on Groovy, so no Groovy warning");

    const { tools } = await server.client.listTools();
    for (const name of ["add_jsr223_sampler", "add_jsr223_preprocessor", "add_jsr223_postprocessor"]) {
      assert.match(tools.find((t) => t.name === name)?.description ?? "", /__UUID/, `${name} should point at built-in functions`);
    }
  } finally {
    await server.close();
  }
});
