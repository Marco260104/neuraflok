import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionSummary } from '../../../../contracts/session.js';
import { META_CANONICAL_PROJECTION, META_HISTORY_SEQ, META_TOKEN_ESTIMATE, type PersistedSummary } from './session-metadata.js';

export interface SessionSummaryWriterDependencies {
  sessionDirectory(sessionId: string): string;
}

export function createSessionSummaryWriter(dependencies: SessionSummaryWriterDependencies) {
  const { sessionDirectory } = dependencies;

  async function writeFileDurably(file: string, contents: string): Promise<void> {
    const handle = await fs.open(file, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      // Flush the complete file before publishing its name with rename.
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  return async function writeSummary(summary: SessionSummary, historySeq: number): Promise<void> {
    const dir = sessionDirectory(summary.id);
    const target = path.join(dir, 'meta.json');
    const backup = path.join(dir, 'meta.backup.json');
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const persisted: PersistedSummary = {
      ...summary,
      [META_HISTORY_SEQ]: historySeq,
      [META_CANONICAL_PROJECTION]: 1,
      [META_TOKEN_ESTIMATE]: 1
    };
    await fs.mkdir(dir, { recursive: true });
    try {
      await writeFileDurably(tmp, JSON.stringify(persisted, null, 2));
      try {
        const current = JSON.parse(await fs.readFile(target, 'utf8')) as SessionSummary;
        if (current?.id === summary.id) {
          const backupTmp = `${backup}.${process.pid}.${randomUUID()}.tmp`;
          try {
            // Replace the backup only with a parsed checkpoint for this session.
            await writeFileDurably(backupTmp, JSON.stringify(current, null, 2));
            await fs.rename(backupTmp, backup);
          } finally {
            await fs.rm(backupTmp, { force: true }).catch(() => undefined);
          }
        }
      } catch {
        // Keep the last validated backup when the primary is missing or damaged.
      }
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  };
}
