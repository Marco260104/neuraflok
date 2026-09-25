import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionEvent } from '../../../../contracts/session.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';

interface Runtime {
  sessionDir: (id: string) => string;
  maxLineBytes: number;
}

export function createSessionJournalRecovery(runtime: Runtime) {
  const { sessionDir, maxLineBytes: MAX_LINE_BYTES } = runtime;
  // Reads the highest seq already on disk, so a restart never reuses a number. Only an absent journal is zero. A journal that exists but cannot be read right now — a Windows share lock from a virus scanner or a backup agent, EMFILE during the 64-wide catalog sweep, an unplugged volume — used to be reported as zero as well, and zero is not a neutral answer here: `readDurableSnapshot()` stamps an empty projection over a session whose history it believes is missing, and the next append then restarts at sequence 1 on top of a journal that already holds thousands of lines. A transient read error must fail the read instead of fabricating the one value that destroys the session it was asked about.
  async function lastSeqOnDisk(id: string): Promise<number> {
    const file = path.join(sessionDir(id), 'events.jsonl');
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch (error) {
      // ENOTDIR is absence too: something with a session-shaped name is sitting in the history folder and is not a folder, so there is no journal under it and never was. Only a path that exists and will not be read is a read failure.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 0;
      throw error;
    }
    // One valid event line may be almost MAX_LINE_BYTES and a crash can leave another almost-full torn line after it. Read enough for both, otherwise the only parseable predecessor can sit outside the tail window and restart would reuse sequence 1.
    const from = Math.max(0, size - (MAX_LINE_BYTES * 2 + 2));
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as SessionEvent;
          if (typeof parsed.seq === 'number') return parsed.seq;
        } catch {
          // A torn final line is expected after a crash; keep looking backwards.
        }
      }
    } finally {
      await handle.close();
    }
    // The file is there and holds no parseable line: a torn first write, and genuinely empty.
    return 0;
  }

  // Closes off a torn last line before anything is appended after it. A crash mid-append leaves a line with no newline. Appending straight onto it would glue a perfectly good new event onto the wreckage and lose that one too, so the damage is sealed with a newline first: one event lost, which is the promise.
  async function sealTornTail(id: string): Promise<void> {
    const file = path.join(sessionDir(id), 'events.jsonl');
    try {
      const stat = await fs.stat(file);
      if (stat.size === 0) return;
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(1);
        await handle.read(buffer, 0, 1, stat.size - 1);
        if (buffer[0] === 0x0a) return;
      } finally {
        await handle.close();
      }
      await fs.appendFile(file, '\n', 'utf8');
      logWarn(`session ${id}: sealed an unterminated final line before appending`);
    } catch {
      // No file yet, or unreadable: the append will recreate it.
    }
  }

  return { lastSeqOnDisk, sealTornTail };
}
