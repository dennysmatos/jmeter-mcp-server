import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { TestNode } from "./jmx/types.js";

/**
 * Newest Java the bundled Groovy is known to cope with. JMeter 5.6.x ships Groovy 3.0.x, which reads
 * class files only up to roughly this generation; on anything newer every Groovy script fails with a
 * class-file/version error. 17 is the safe LTS to recommend, 21 is the last version not seen failing.
 */
export const MAX_SUPPORTED_JAVA = 21;
export const RECOMMENDED_JAVA = 17;

const JSR223_TYPES = new Set(["JSR223Sampler", "JSR223PreProcessor", "JSR223PostProcessor"]);

export interface RuntimeInfo {
  javaMajor: number | null;
  javaCommand: string;
  groovyVersion: string | null;
}

/** "26.0.1" -> 26, "1.8.0_402" -> 8, "17" -> 17. */
export function parseJavaMajor(versionOutput: string): number | null {
  const match = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const first = Number(match[1]);
  return first === 1 && match[2] !== undefined ? Number(match[2]) : first;
}

export function parseGroovyVersion(libFileNames: string[]): string | null {
  for (const name of libFileNames) {
    const match = name.match(/^groovy-(\d+\.\d+\.\d+)\.jar$/);
    if (match) return match[1];
  }
  return null;
}

function javaCommand(env: NodeJS.ProcessEnv): string {
  const javaHome = env.JAVA_HOME;
  if (javaHome) {
    const candidate = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (existsSync(candidate)) return candidate;
  }
  return "java";
}

/** What the JMeter launcher will end up running: JAVA_HOME's java if set, otherwise the one on PATH. */
export function detectRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeInfo {
  const command = javaCommand(env);
  let javaMajor: number | null = null;
  try {
    const result = spawnSync(command, ["-version"], { encoding: "utf-8", timeout: 10_000 });
    javaMajor = parseJavaMajor(`${result.stderr ?? ""}${result.stdout ?? ""}`);
  } catch {
    javaMajor = null;
  }

  let groovyVersion: string | null = null;
  if (env.JMETER_HOME) {
    // A tarball install keeps jars in lib/; Homebrew moves the real install to libexec/.
    for (const libDir of ["lib", path.join("libexec", "lib")]) {
      try {
        groovyVersion = parseGroovyVersion(readdirSync(path.join(env.JMETER_HOME, libDir)));
      } catch {
        groovyVersion = null;
      }
      if (groovyVersion) break;
    }
  }
  return { javaMajor, javaCommand: command, groovyVersion };
}

/**
 * The warning to show before a Groovy script is used, or null when it should work or when the
 * environment couldn't be read (an unknown version is not a reason to cry wolf).
 */
export function assessGroovyCompat(runtime: Pick<RuntimeInfo, "javaMajor" | "groovyVersion">): string | null {
  const { javaMajor, groovyVersion } = runtime;
  if (javaMajor === null || javaMajor <= MAX_SUPPORTED_JAVA) return null;
  const groovy = groovyVersion ? `Groovy ${groovyVersion}` : "the Groovy bundled with JMeter";
  return (
    `JSR223 Groovy scripts will likely fail here: JMeter runs on Java ${javaMajor}, but ${groovy} only supports ` +
    `Java ${MAX_SUPPORTED_JAVA} and older. Every script execution would throw, which ends that virtual user's ` +
    `iteration after its first request(s) and can look like load that never grows. Either avoid scripts - use ` +
    `built-in functions such as \${__UUID}, \${__RandomString}, \${__Random}, \${__time} or CSV Data Set Config - ` +
    `or run JMeter on Java ${RECOMMENDED_JAVA} (LTS) by setting JAVA_HOME in this MCP server's environment and ` +
    `restarting it.`
  );
}

let cached: RuntimeInfo | undefined;

/** Detection spawns a JVM, so do it once per server process. */
export function currentRuntime(): RuntimeInfo {
  cached ??= detectRuntime();
  return cached;
}

export function groovyWarning(): string | null {
  return assessGroovyCompat(currentRuntime());
}

export function planUsesGroovy(node: TestNode): boolean {
  if (JSR223_TYPES.has(node.type)) {
    const language = node.props.scriptLanguage;
    return language === undefined || language === "groovy";
  }
  return node.children.some(planUsesGroovy);
}

/** Warning for a plan that contains at least one Groovy JSR223 element, else null. */
export function planGroovyWarning(root: TestNode): string | null {
  return planUsesGroovy(root) ? groovyWarning() : null;
}
