import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJtl } from "../src/report/jtlParser.js";
import { computeAggregate } from "../src/report/aggregate.js";
import { liveProgressFrom, readLiveProgress } from "../src/report/liveProgress.js";

function writeJtl(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jtl-test-"));
  const file = join(dir, "results.jtl");
  writeFileSync(file, content, "utf-8");
  return file;
}

const HEADER = "timeStamp,elapsed,label,responseCode,responseMessage,success,bytes,Latency";

test("parses a well-formed JTL", () => {
  const file = writeJtl(
    [
      HEADER,
      "1000,120,Login,200,OK,true,512,110",
      "1010,90,Register,201,Created,true,600,80",
    ].join("\n"),
  );
  const samples = parseJtl(file);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].label, "Login");
  assert.equal(samples[1].label, "Register");
});

test("keeps a quoted field with an embedded comma on one row", () => {
  const file = writeJtl(
    [
      HEADER,
      `1000,120,Login,200,"comma, inside message",true,512,110`,
      "1010,90,Register,201,Created,true,600,80",
    ].join("\n"),
  );
  const samples = parseJtl(file);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].label, "Login");
  assert.equal(samples[1].label, "Register");
});

test("keeps a quoted field with an embedded newline on one row instead of splitting it into a phantom row", () => {
  const stackTrace = "Error: bcrypt failed\n    at compareSync (bcrypt.js:1)\n    at login (app.js:42)";
  const file = writeJtl(
    [
      HEADER,
      `1000,5000,Login,500,"${stackTrace}",false,0,4900`,
      "1010,90,Register,201,Created,true,600,80",
    ].join("\n"),
  );
  const samples = parseJtl(file);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].label, "Login");
  assert.equal(samples[0].success, false);
  assert.equal(samples[1].label, "Register");

  // The old line-first parser would have split the embedded newlines into
  // extra malformed rows, each with a misaligned/empty label.
  const aggregate = computeAggregate(samples);
  assert.equal(aggregate.byLabel.some((s) => s.label === ""), false);
  assert.equal(aggregate.overall.count, 2);
});

test("unescapes doubled quotes inside a quoted field", () => {
  const file = writeJtl(
    [HEADER, `1000,120,Login,200,"she said ""hi""",true,512,110`].join("\n"),
  );
  const samples = parseJtl(file);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].label, "Login");
});

test("skipIncompleteTrailingRow drops a row JMeter was still writing", () => {
  const file = writeJtl([HEADER, "1000,120,Login,200,OK,true,512,110", "1010,90,Regis"].join("\n"));
  assert.equal(parseJtl(file).length, 2);
  const samples = parseJtl(file, { skipIncompleteTrailingRow: true });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].label, "Login");
});

test("liveProgressFrom summarizes a run in flight, overall and per label", () => {
  const samples = [
    { timestamp: 0, elapsed: 100, label: "login", responseCode: "200", success: true, bytes: 1, latency: 1 },
    { timestamp: 5_000, elapsed: 200, label: "signup", responseCode: "200", success: true, bytes: 1, latency: 1 },
    { timestamp: 20_000, elapsed: 400, label: "signup", responseCode: "500", success: false, bytes: 1, latency: 1 },
  ];
  const progress = liveProgressFrom(samples);
  assert.ok(progress);
  assert.equal(progress.samples, 3);
  assert.equal(progress.errors, 1);
  assert.equal(progress.errorPct, 33.33);
  assert.equal(progress.runSeconds, 20);
  // Only the last sample ends inside the final 10s window.
  assert.equal(progress.recentThroughputPerSec, 0.1);
  assert.deepEqual(
    progress.byLabel.map((l) => [l.label, l.samples]),
    [
      ["login", 1],
      ["signup", 2],
    ],
  );
});

test("liveProgressFrom has nothing to say before the first sample", () => {
  assert.equal(liveProgressFrom([]), null);
});

test("readLiveProgress explains itself instead of throwing when there is nothing to read", () => {
  assert.match((readLiveProgress(undefined) as { unavailable: string }).unavailable, /no Aggregate Report/);
  assert.match((readLiveProgress("/nonexistent/results.jtl") as { unavailable: string }).unavailable, /No samples written yet/);
  const headerOnly = writeJtl(HEADER + "\n");
  assert.match((readLiveProgress(headerOnly) as { unavailable: string }).unavailable, /No samples written yet/);
});
