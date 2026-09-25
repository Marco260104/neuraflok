// Detects Java and Go installations for Windows child processes.
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { envValue, pathEntries, prependPath, setEnvValue, type MutableEnvironment } from '../../../infrastructure/settings/env.js';

// Defines the filesystem checks used to discover toolchains.
export interface ToolchainProbe {
  isFile(target: string): boolean;
  directories(target: string): string[];
}

// Uses the local filesystem for toolchain discovery.
export const realProbe: ToolchainProbe = {
  isFile(target) {
    try {
      return existsSync(target) && statSync(target).isFile();
    } catch {
      return false;
    }
  },
  directories(target) {
    try {
      return readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(target, entry.name));
    } catch {
      return [];
    }
  }
};

// Checks common JDK install locations in a stable preference order.
function javaCandidates(env: MutableEnvironment): string[] {
  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? '';

  // Prefer Android Studio bundled runtimes before generic JDK installs.
  const exact = [
    path.join(programFiles, 'Android', 'Android Studio', 'jbr'),
    path.join(programFiles, 'Android', 'Android Studio', 'jre'),
    localAppData ? path.join(localAppData, 'Programs', 'Android Studio', 'jbr') : '',
    path.join(programFilesX86, 'Android', 'Android Studio', 'jbr')
  ].filter(Boolean);

  // Search vendor-specific versioned install roots after exact locations.
  const scanned = [
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFiles, 'Java'),
    path.join(programFiles, 'Microsoft'),
    path.join(programFiles, 'Amazon Corretto'),
    path.join(programFiles, 'Zulu'),
    path.join(programFiles, 'JetBrains', 'Toolbox', 'apps')
  ];

  return [...exact, ...scanned];
}

// Checks standard Go install roots when GOROOT is unset.
function goCandidates(env: MutableEnvironment): string[] {
  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? '';
  return [
    path.join(programFiles, 'Go'),
    localAppData ? path.join(localAppData, 'Programs', 'Go') : '',
    'C:\\Go'
  ].filter(Boolean);
}

// Checks each candidate and one versioned child level for the requested executable.
function firstToolchain(candidates: readonly string[], executable: string, probe: ToolchainProbe): string | null {
  for (const candidate of candidates) {
    if (probe.isFile(path.join(candidate, 'bin', executable))) return candidate;
    for (const child of probe.directories(candidate).sort(byVersionDescending)) {
      if (probe.isFile(path.join(child, 'bin', executable))) return child;
    }
  }
  return null;
}

// Sorts versioned directory names numerically and resolves ties deterministically.
function byVersionDescending(left: string, right: string): number {
  const chunks = (name: string): string[] => path.basename(name).toLowerCase().match(/\d+|\D+/g) ?? [];
  const a = chunks(left);
  const b = chunks(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const numeric = /^\d/.test(x) && /^\d/.test(y);
    const order = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return -order;
  }
  return left < right ? 1 : left > right ? -1 : 0;
}

interface Discovery {
  javaHome: string | null;
  goRoot: string | null;
}

let cached: Discovery | null = null;
let reachability = new WeakMap<ToolchainProbe, Map<string, { java: boolean; go: boolean }>>();

// Clears discovery state between isolated test environments.
export function resetToolchainCache(): void {
  cached = null;
  reachability = new WeakMap();
}

// Caches executable reachability by probe and the exact PATH value.
function pathReachability(env: MutableEnvironment, probe: ToolchainProbe): { java: boolean; go: boolean } {
  const key = envValue(env, 'PATH') ?? '';
  let cache = reachability.get(probe);
  if (!cache) {
    cache = new Map();
    reachability.set(probe, cache);
  }
  const held = cache.get(key);
  if (held) return held;

  let java = false;
  let go = false;
  for (const entry of pathEntries(env)) {
    if (!java && probe.isFile(path.join(entry, 'java.exe'))) java = true;
    if (!go && probe.isFile(path.join(entry, 'go.exe'))) go = true;
    if (java && go) break;
  }
  const found = { java, go };
  cache.set(key, found);
  if (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return found;
}

// Finds verified toolchain roots only when the caller needs them.
function discover(env: MutableEnvironment, probe: ToolchainProbe): Discovery {
  if (cached !== null) return cached;
  cached = {
    // Require the compiler executable so JAVA_HOME never resolves to a JRE.
    javaHome: firstToolchain(javaCandidates(env), 'javac.exe', probe),
    goRoot: firstToolchain(goCandidates(env), 'go.exe', probe)
  };
  return cached;
}

// Adds missing toolchain variables without replacing user settings or PATH tools.
export function ensureDevToolchain(env: MutableEnvironment, probe: ToolchainProbe = realProbe): string[] {
  if (process.platform !== 'win32') return [];
  const added: string[] = [];

  const existingJavaHome = envValue(env, 'JAVA_HOME');
  const existingGoRoot = envValue(env, 'GOROOT');
  const reachable = existingJavaHome === undefined || existingGoRoot === undefined
    ? pathReachability(env, probe)
    : { java: true, go: true };
  const needsJava = existingJavaHome === undefined && !reachable.java;
  const needsGo = existingGoRoot === undefined && !reachable.go;
  if (!needsJava && !needsGo) return added;

  const found = discover(env, probe);

  if (needsJava && found.javaHome !== null) {
    setEnvValue(env, 'JAVA_HOME', found.javaHome);
    prependPath(env, path.join(found.javaHome, 'bin'));
    added.push(`JAVA_HOME=${found.javaHome}`);
  }
  if (needsGo && found.goRoot !== null) {
    setEnvValue(env, 'GOROOT', found.goRoot);
    prependPath(env, path.join(found.goRoot, 'bin'));
    added.push(`GOROOT=${found.goRoot}`);
  }

  return added;
}
