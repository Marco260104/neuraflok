import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logWarn } from '../../infrastructure/settings/logger.js';

export class DurableStateFiles {
  private root = '';

  get isReady(): boolean {
    return this.root.length > 0;
  }

  initialize(userDataDir: string): void {
    this.root = path.join(userDataDir, 'state');
  }

  async read<T>(name: string): Promise<T | null> {
    if (!this.root) return null;
    try {
      const raw = await fs.readFile(this.fileFor(name), 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') logWarn(`could not read ${name} state: ${(error as Error).message}`);
      return null;
    }
  }

  async replace(name: string, value: unknown): Promise<void> {
    if (!this.root) return;
    const target = this.fileFor(name);
    const temporary = `${target}.tmp`;
    try {
      await fs.mkdir(this.root, { recursive: true });
      if (value === null) {
        await fs.rm(target, { force: true });
        return;
      }
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new TypeError('Durable state must be JSON serializable.');
      await fs.writeFile(temporary, serialized, 'utf8');
      await fs.rename(temporary, target);
    } catch (error) {
      logWarn(`could not save ${name} state: ${(error as Error).message}`);
      throw error;
    }
  }

  reset(): void {
    this.root = '';
  }

  private fileFor(name: string): string {
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`Invalid durable state name: ${name}`);
    return path.join(this.root, `${name}.json`);
  }
}
