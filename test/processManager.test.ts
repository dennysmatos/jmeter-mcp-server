import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnInvocation, elapsedSeconds, isLogNoise } from "../src/execution/processManager.js";

test("buildSpawnInvocation leaves non-Windows spawns untouched", () => {
  const result = buildSpawnInvocation("/opt/jmeter/bin/jmeter", ["-n", "-t", "/tmp/plan.jmx"], "linux");
  assert.equal(result.shell, false);
  assert.equal(result.command, "/opt/jmeter/bin/jmeter");
  assert.deepEqual(result.args, ["-n", "-t", "/tmp/plan.jmx"]);
});

test("buildSpawnInvocation leaves a non-batch Windows binary untouched", () => {
  const result = buildSpawnInvocation("C:\\jmeter\\bin\\jmeter.exe", ["-n"], "win32");
  assert.equal(result.shell, false);
  assert.equal(result.command, "C:\\jmeter\\bin\\jmeter.exe");
});

test("buildSpawnInvocation routes .bat files through the shell on Windows", () => {
  const result = buildSpawnInvocation("C:\\jmeter\\bin\\jmeter.bat", ["-n", "-t", "plan.jmx"], "win32");
  assert.equal(result.shell, true);
  assert.equal(result.command, "C:\\jmeter\\bin\\jmeter.bat");
});

test("buildSpawnInvocation quotes Windows paths containing spaces", () => {
  const result = buildSpawnInvocation(
    "C:\\Program Files\\jmeter\\bin\\jmeter.bat",
    ["-n", "-t", "C:\\Users\\Jane Doe\\plan.jmx"],
    "win32",
  );
  assert.equal(result.command, '"C:\\Program Files\\jmeter\\bin\\jmeter.bat"');
  assert.deepEqual(result.args, ["-n", "-t", '"C:\\Users\\Jane Doe\\plan.jmx"']);
});

test("buildSpawnInvocation is case-insensitive for .cmd files", () => {
  const result = buildSpawnInvocation("C:\\jmeter\\bin\\jmeter.CMD", [], "win32");
  assert.equal(result.shell, true);
});

test("isLogNoise drops JVM and Log4j startup chatter but keeps JMeter's own lines", () => {
  assert.equal(isLogNoise("WARNING: package sun.awt.X11 not in java.desktop"), true);
  assert.equal(isLogNoise("WARN StatusConsoleListener The use of package scanning to locate plugins is deprecated"), true);
  assert.equal(isLogNoise("WARNING: sun.misc.Unsafe::objectFieldOffset has been called"), true);
  assert.equal(isLogNoise("summary +  1200 in 00:00:30 =   40.0/s Avg:    50 Min:     3 Max:   400 Err:     0 (0.00%)"), false);
  assert.equal(isLogNoise("Starting standalone test @ 2026 Sep 21 11:28:04 PDT (1790015284577)"), false);
});

test("elapsedSeconds measures to endTime when the run has finished", () => {
  assert.equal(elapsedSeconds({ startTime: "2026-01-01T00:00:00.000Z", endTime: "2026-01-01T00:01:30.000Z" }), 90);
});
