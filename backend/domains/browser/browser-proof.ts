import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logWarn } from '../../infrastructure/settings/logger.js';

type Proof = { browserId: string; version: string; installedAt: number };

let filePath = '';
let proof: Proof | null = null;
let writing: Promise<void> = Promise.resolve();

export function initBrowserProofPath(userDataDir: string): void {
  filePath = path.join(userDataDir, 'browser-proof.json');
}

export async function loadBrowserProof(): Promise<void> {
  proof = null;
  if (!filePath) return;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { external?: Partial<Proof> };
    const value = parsed.external;
    if (value && typeof value.browserId === 'string' && /^[a-z0-9]{16,64}$/.test(value.browserId) &&
        typeof value.version === 'string' && value.version.length <= 32 &&
        typeof value.installedAt === 'number' && Number.isFinite(value.installedAt) && value.installedAt > 0) {
      proof = { browserId: value.browserId, version: value.version, installedAt: value.installedAt };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`Browser proof unreadable: ${(error as Error).message}`);
  }
}

function persist(): void {
  if (!filePath) return;
  writing = writing.then(async () => {
    const temporary = `${filePath}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, external: proof }), 'utf8');
      await fs.rename(temporary, filePath);
    } catch (error) {
      logWarn(`Browser proof not saved: ${(error as Error).message}`);
    }
  });
}

export function noteExternalInstalled(browserId: string, version: string, at = Date.now()): boolean {
  if (proof?.browserId === browserId && proof.version === version) return false;
  proof = { browserId, version, installedAt: at };
  persist();
  return true;
}

export function externalBrowserProof(): Proof | null {
  return proof && { ...proof };
}

export function browserProofWritten(): Promise<void> {
  return writing;
}

export function resetBrowserProofForTests(): void {
  proof = null;
  filePath = '';
}
