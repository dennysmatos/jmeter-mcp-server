import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessGroovyCompat,
  cleanEnvPath,
  detectRuntime,
  javaCommandFor,
  parseGroovyVersion,
  parseJavaMajor,
  planUsesGroovy,
  type DetectDeps,
} from "../src/jsr223Compat.js";
import { createNode, addChild } from "../src/jmx/tree.js";
import { startServer, callTool } from "./support/mcpClient.js";

test("parseJavaMajor reads modern and legacy version strings", () => {
  assert.equal(parseJavaMajor('java version "26.0.1" 2026-04-21\nJava(TM) SE Runtime Environment'), 26);
  assert.equal(parseJavaMajor('openjdk version "17.0.10" 2024-01-16'), 17);
  assert.equal(parseJavaMajor('openjdk version "21" 2023-09-19'), 21);
  assert.equal(parseJavaMajor('java version "1.8.0_402"'), 8);
  assert.equal(parseJavaMajor("command not found"), null);
});

test("parseJavaMajor copes with Windows line endings and JAVA_TOOL_OPTIONS noise", () => {
  const output = 'Picked up JAVA_TOOL_OPTIONS: -Xmx2g\r\nopenjdk version "26-ea" 2026-03-17\r\nOpenJDK Runtime Environment\r\n';
  assert.equal(parseJavaMajor(output), 26);
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

function fakeDeps(over: Partial<DetectDeps> & { files?: Record<string, string[]>; java?: string }): DetectDeps {
  return {
    platform: "linux",
    exists: () => false,
    readDir(dir) {
      const found = over.files?.[dir];
      if (!found) throw new Error("ENOENT");
      return found;
    },
    runJavaVersion: () => over.java ?? "",
    ...over,
  };
}

test("cleanEnvPath strips the quotes and whitespace Windows users put around JAVA_HOME", () => {
  assert.equal(cleanEnvPath('"C:\\Program Files\\Java\\jdk-17"'), "C:\\Program Files\\Java\\jdk-17");
  assert.equal(cleanEnvPath("  /usr/lib/jvm/17  "), "/usr/lib/jvm/17");
  assert.equal(cleanEnvPath(""), undefined);
  assert.equal(cleanEnvPath(undefined), undefined);
});

test("Windows: JAVA_HOME resolves to bin\\java.exe with backslashes, even when quoted or with a trailing slash", () => {
  const jdk = "C:\\Program Files\\Java\\jdk-17";
  const expected = `${jdk}\\bin\\java.exe`;
  const exists = (file: string) => file === expected;
  assert.equal(javaCommandFor({ JAVA_HOME: `"${jdk}"` }, { platform: "win32", exists }), expected);
  assert.equal(javaCommandFor({ JAVA_HOME: `${jdk}\\` }, { platform: "win32", exists }), expected);
});

test("macOS/Linux: JAVA_HOME resolves to bin/java; a stale JAVA_HOME or none falls back to PATH's java", () => {
  const exists = (file: string) => file === "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java";
  assert.equal(
    javaCommandFor({ JAVA_HOME: "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home" }, { platform: "darwin", exists }),
    "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java",
  );
  assert.equal(javaCommandFor({ JAVA_HOME: "/gone" }, { platform: "darwin", exists }), "java");
  assert.equal(javaCommandFor({}, { platform: "darwin", exists }), "java");
});

test("Windows: detects Java from java.exe and Groovy from lib\\ in a zip-style JMeter install", () => {
  const runtime = detectRuntime(
    { JAVA_HOME: "C:\\jdk-26", JMETER_HOME: "C:\\tools\\apache-jmeter-5.6.3" },
    fakeDeps({
      platform: "win32",
      exists: (f) => f === "C:\\jdk-26\\bin\\java.exe",
      java: 'java version "26.0.1" 2026-04-21\r\n',
      files: { "C:\\tools\\apache-jmeter-5.6.3\\lib": ["groovy-3.0.20.jar", "commons-io-2.15.jar"] },
    }),
  );
  assert.deepEqual(runtime, { javaMajor: 26, javaCommand: "C:\\jdk-26\\bin\\java.exe", groovyVersion: "3.0.20" });
});

test("macOS Homebrew: Groovy is found under libexec/lib when lib/ has no jars", () => {
  const home = "/opt/homebrew/Cellar/jmeter/5.6.3";
  const runtime = detectRuntime(
    { JMETER_HOME: home },
    fakeDeps({
      platform: "darwin",
      java: 'openjdk version "17.0.10"',
      files: { [`${home}/libexec/lib`]: ["groovy-3.0.20.jar"] },
    }),
  );
  assert.equal(runtime.groovyVersion, "3.0.20");
  assert.equal(runtime.javaMajor, 17);
  assert.equal(runtime.javaCommand, "java");
});

test("detectRuntime degrades to unknown - not an error - when java can't run or JMeter's lib is unreadable", () => {
  const runtime = detectRuntime(
    { JMETER_HOME: "C:\\nowhere" },
    fakeDeps({
      platform: "win32",
      runJavaVersion() {
        throw new Error("spawn java ENOENT");
      },
    }),
  );
  assert.deepEqual(runtime, { javaMajor: null, javaCommand: "java", groovyVersion: null });
  assert.equal(assessGroovyCompat(runtime), null);
});
