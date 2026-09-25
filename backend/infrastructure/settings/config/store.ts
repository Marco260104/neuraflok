import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Capabilities, Config } from '../../../../contracts/types.js';
import { WRITE_CAPABILITIES } from '../../../../contracts/types.js';
import { configSchema } from './schema.js';
import { conservativeRecoveryConfig, defaultConfig } from './defaults.js';
import { migrateStoredConfig, upgradeConfigDefaults } from './migrations.js';
import { logError, logWarn } from '../logger.js';
import { APP_VERSION } from '../version.js';
import { capabilitiesForPlatform } from '../platform.js';

let configPath = '';
let current: Config = defaultConfig();
// This run started from conservativeRecoveryConfig. Setup says so beside its access choice, because read-only with no reason given reads as a broken app. Lasts until read-only is switched off.
let recovered = false;

export function settingsRecovered(): boolean {
  return recovered;
}
// Every UI mutation ultimately lands in the same tiny JSON file. Keep those read-modify-write transactions strictly ordered so two fast checkbox/root changes cannot race on config.json.tmp or overwrite each other's newer state.
let mutationQueue: Promise<void> = Promise.resolve();

export function initConfigPath(userDataDir: string): void {
  configPath = path.join(userDataDir, 'config.json');
}

/** Keeps an unusable settings file before recovery defaults can replace it. The next save after a failed read writes recovery settings over it. A Windows test showed that a byte-order mark could make saved folders and settings disappear within a second; this copy preserves the original bytes without blocking startup if it fails. */
async function keepUnreadable(raw: string): Promise<void> {
  const copy = `${configPath}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await fs.writeFile(copy, raw, 'utf8');
    logError(`The settings file could not be used; its original was kept as ${path.basename(copy)}`);
  } catch (error) {
    logError(`Could not keep a copy of the unusable settings file: ${(error as Error).message}`);
  }
}

export async function loadConfig(): Promise<Config> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(configPath, 'utf8');
    // Windows PowerShell 5.1 and older Notepad start UTF-8 files with a byte-order mark; it is not JSON.
    const rawValue: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const rawConfig = rawValue;
    const parsed = configSchema.safeParse(migrateStoredConfig(rawConfig));
    if (!parsed.success) {
      logError('Settings file was invalid and has been reset to defaults');
      await keepUnreadable(raw);
      current = conservativeRecoveryConfig();
      recovered = true;
    } else {
      current = upgradeConfigDefaults(parsed.data);
      // Duplicate root names would make a virtual path ambiguous.
      const seen = new Set<string>();
      current.roots = current.roots.filter((r) => {
        const key = r.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const stored = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
        ? rawConfig as Record<string, unknown>
        : {};
      const hasRetiredConnectorSettings = ['tunnel', 'connectorSuffix', 'setupProfiles', 'mcp'].some(key =>
        Object.prototype.hasOwnProperty.call(stored, key)
      );
      if (hasRetiredConnectorSettings) {
        try {
          await persistConfig(current);
        } catch (error) {
          logWarn(`Retired connector settings could not be removed from the saved config: ${(error as Error).message}`);
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`Could not read settings: ${(err as Error).message}`);
      if (raw !== null) await keepUnreadable(raw);
      current = conservativeRecoveryConfig();
      recovered = true;
    } else {
      // A fresh install has nothing new to show: it records its own version before anything can.
      current = { ...defaultConfig(), ui: { ...defaultConfig().ui, lastSeenVersion: APP_VERSION } };
    }
  }
  return current;
}

export function getConfig(): Config {
  return current;
}

/** Read-only mode is enforced here as well as at the tool layer, so the effective capability set can never disagree with what the UI shows. */
export function effectiveCapabilities(
  config: Config,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  const live = capabilitiesForPlatform(config.capabilities, platform, release);
  if (!config.readOnly) return live;
  // Derived from WRITE_CAPABILITIES rather than listed again here, so adding a new writing capability cannot accidentally leave it enabled in read-only mode.
  const capped = { ...live };
  for (const capability of WRITE_CAPABILITIES) capped[capability] = false;
  return capped;
}

async function persistConfig(parsed: Config): Promise<Config> {
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
  await fs.rename(tmp, configPath);
  // Only publish the new in-memory state after the durable write succeeded. A disk error must not leave the UI believing settings were saved when they were not.
  current = parsed;
  if (!parsed.readOnly) recovered = false;
  return current;
}

/** Atomically updates settings from the latest committed state. The callback itself runs inside the queue. This matters more than merely queuing the final file write: a root change and a permission change that start at the same time must each see the result of the one ahead of it instead of composing two stale full Config objects and letting the later write silently erase the earlier change. */
export function updateConfig(
  update: (latest: Config) => Config | Promise<Config>,
  afterPublish?: (next: Config, previous: Config) => void | Promise<void>,
  publish?: (next: Config, previous: Config, persist: () => Promise<Config>) => Promise<Config>
): Promise<Config> {
  const operation = mutationQueue.then(async () => {
    const previous = current;
    // Validate before reserving external resources. The optional publisher owns their rollback.
    const proposed = configSchema.parse(await update(previous));
    const persist = () => persistConfig(proposed);
    const next = await (publish ? publish(proposed, previous, persist) : persist());
    // Keep dependent durable retirement inside the same settings transaction; the next On cannot overtake a published Off's cancellation work.
    await afterPublish?.(next, previous);
    return next;
  });
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

/** Replaces the complete config. Prefer updateConfig for read-modify-write changes. */
export function saveConfig(next: Config): Promise<Config> {
  return updateConfig(() => next);
}
