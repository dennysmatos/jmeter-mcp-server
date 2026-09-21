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

/** Windows users commonly set JAVA_HOME with surrounding quotes, and a trailing separator is common everywhere. */
export function cleanEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^"(.*)"$/, "$1").trim();
  return trimmed ? trimmed : undefined;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  exists(file: string): boolean;
  readDir(dir: string): string[];
  /** Runs `<command> -version` and returns everything it printed (Java writes the version to stderr). */
  runJavaVersion(command: string): string;
}

const realDeps: DetectDeps = {
  platform: process.platform,
  exists: existsSync,
  readDir: (dir) => readdirSync(dir),
  runJavaVersion(command) {
    const result = spawnSync(command, ["-version"], { encoding: "utf-8", timeout: 10_000, windowsHide: true });
    return `${result.stderr ?? ""}${result.stdout ?? ""}`;
  },
};

/** Paths are built with the target platform's rules, so a Windows layout is right even when checked elsewhere. */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * The java the JMeter launcher will use: jmeter.bat and bin/jmeter both prefer JAVA_HOME/bin/java
 * and otherwise fall back to whatever `java` is on PATH.
 */
export function javaCommandFor(env: NodeJS.ProcessEnv, deps: Pick<DetectDeps, "platform" | "exists">): string {
  const p = pathFor(deps.platform);
  const javaHome = cleanEnvPath(env.JAVA_HOME);
  if (javaHome) {
    const candidate = p.join(javaHome, "bin", deps.platform === "win32" ? "java.exe" : "java");
    if (deps.exists(candidate)) return candidate;
  }
  return "java";
}

/**
 * Directories that can hold JMeter's jars: lib/ in a zip/tarball install (and Windows package
 * managers such as Chocolatey or Scoop), libexec/lib/ where Homebrew moves the real install.
 */
export function jmeterLibDirs(jmeterHome: string, platform: NodeJS.Platform): string[] {
  const p = pathFor(platform);
  return [p.join(jmeterHome, "lib"), p.join(jmeterHome, "libexec", "lib")];
}

export function detectRuntime(env: NodeJS.ProcessEnv = process.env, deps: DetectDeps = realDeps): RuntimeInfo {
  const command = javaCommandFor(env, deps);
  let javaMajor: number | null = null;
  try {
    javaMajor = parseJavaMajor(deps.runJavaVersion(command));
  } catch {
    javaMajor = null;
  }

  let groovyVersion: string | null = null;
  const jmeterHome = cleanEnvPath(env.JMETER_HOME);
  if (jmeterHome) {
    for (const libDir of jmeterLibDirs(jmeterHome, deps.platform)) {
      try {
        groovyVersion = parseGroovyVersion(deps.readDir(libDir));
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
