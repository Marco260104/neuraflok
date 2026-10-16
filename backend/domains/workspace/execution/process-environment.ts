import path from 'node:path';
import { locateRipgrep } from '../../../infrastructure/binaries/ripgrep.js';
import { ExecError, MAX_ENV_KEY_CHARS, MAX_ENV_VALUE_CHARS, MAX_ENV_VARS, type CommandEnvironment } from './process-contract.js';
import { UNIFIED_EXEC_ENV } from './unified-exec-constants.js';

const PRIVATE_PARENT_KEYS = new Set([
  'CONTROL_PLANE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'CLOUDFLARED_TOKEN',
  'CLOUDFLARED_TUNNEL_TOKEN'
]);

interface EnvironmentEntry {
  name: string;
  value: string;
}

type EnvironmentTable = Map<string, EnvironmentEntry>;

export interface ChildEnvironmentBuild {
  source: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  ripgrepPath: string | null;
  overrides?: CommandEnvironment;
}

function environmentId(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

function readValue(env: EnvironmentTable, name: string, platform: NodeJS.Platform): string | undefined {
  return env.get(environmentId(name, platform))?.value;
}

function writeValue(env: EnvironmentTable, name: string, value: string, platform: NodeJS.Platform): void {
  const id = environmentId(name, platform);
  const existing = env.get(id);
  env.set(id, { name: existing?.name ?? name, value });
}

function fromHost(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): EnvironmentTable {
  const env: EnvironmentTable = new Map();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const id = environmentId(name, platform);
    const previous = env.get(id);
    if (!previous) env.set(id, { name, value });
    else if (!previous.value) env.set(id, { name: previous.name, value });
  }
  return env;
}

function validateOverrides(overrides: CommandEnvironment | undefined): void {
  if (!overrides) return;
  const entries = Object.entries(overrides);
  if (entries.length > MAX_ENV_VARS) throw new ExecError(`Too many environment variables (limit ${MAX_ENV_VARS})`);
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > MAX_ENV_KEY_CHARS || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ExecError(`Invalid environment variable name: ${name.slice(0, MAX_ENV_KEY_CHARS) || '(empty)'}`);
    }
    if (name.toUpperCase().startsWith('NEURAFLOK_')) {
      throw new ExecError('Environment variable names beginning with NEURAFLOK_ are reserved by the app');
    }
    if (typeof value !== 'string') throw new ExecError(`Environment variable ${name} must be a string`);
    if (value.includes('\0')) throw new ExecError(`Environment variable ${name} contains a null byte`);
    if (value.length > MAX_ENV_VALUE_CHARS) {
      throw new ExecError(`Environment variable ${name} is too long (limit ${MAX_ENV_VALUE_CHARS} characters)`);
    }
  }
}

function pathEntries(env: EnvironmentTable, platform: NodeJS.Platform): string[] {
  const separator = platform === 'win32' ? ';' : ':';
  return (readValue(env, 'PATH', platform) ?? '')
    .split(separator)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function withToolDirectory(env: EnvironmentTable, executable: string | null, platform: NodeJS.Platform): void {
  if (!executable) return;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const directory = pathApi.dirname(executable);
  const held = pathEntries(env, platform);
  const sameDirectory = (entry: string): boolean => platform === 'win32'
    ? entry.toLowerCase() === directory.toLowerCase()
    : entry === directory;
  const rest = held.filter(entry => !sameDirectory(entry));
  writeValue(env, 'PATH', [directory, ...rest].join(platform === 'win32' ? ';' : ':'), platform);
}

function withWindowsSystemDirectories(env: EnvironmentTable, platform: NodeJS.Platform): void {
  if (platform !== 'win32') return;
  const root = readValue(env, 'SystemRoot', platform) || readValue(env, 'windir', platform) || 'C:\\Windows';
  const system32 = `${root}\\System32`;
  const defaults = [system32, root, `${system32}\\Wbem`, `${system32}\\WindowsPowerShell\\v1.0`];
  const held = pathEntries(env, platform);
  const missing = defaults.filter(directory => !held.some(entry => entry.toLowerCase() === directory.toLowerCase()));
  if (missing.length) writeValue(env, 'PATH', [...held, ...missing].join(';'), platform);
}

function removePrivateParentValues(env: EnvironmentTable): void {
  for (const id of env.keys()) if (PRIVATE_PARENT_KEYS.has(id)) env.delete(id);
}

function applyOverrides(env: EnvironmentTable, overrides: CommandEnvironment | undefined, platform: NodeJS.Platform): void {
  if (!overrides) return;
  for (const [name, value] of Object.entries(overrides)) writeValue(env, name, value, platform);
}

function composeEnvironment(input: ChildEnvironmentBuild): NodeJS.ProcessEnv {
  const { platform } = input;
  const env = fromHost(input.source, platform);
  withToolDirectory(env, input.ripgrepPath, platform);
  removePrivateParentValues(env);
  applyOverrides(env, input.overrides, platform);
  withWindowsSystemDirectories(env, platform);
  return Object.fromEntries([...env.values()].map(entry => [entry.name, entry.value])) as NodeJS.ProcessEnv;
}

export function buildChildEnvironment(input: ChildEnvironmentBuild): NodeJS.ProcessEnv {
  validateOverrides(input.overrides);
  return composeEnvironment(input);
}

export function childEnv(overrides?: CommandEnvironment): NodeJS.ProcessEnv {
  validateOverrides(overrides);
  return composeEnvironment({ source: process.env, platform: process.platform, ripgrepPath: locateRipgrep(), overrides });
}

export function applyUnifiedExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of UNIFIED_EXEC_ENV) result[key] = value;
  return result;
}
