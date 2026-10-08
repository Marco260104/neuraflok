import {
  DEFAULT_HANDOFF_PROMPT,
  appendEvent,
  createSession,
  deleteSession,
  flushSessions,
  fs,
  getSession,
  latestHandoff,
  nativeHandoffPrompt,
  path,
  pruneSessions,
  readHandoff,
  resetSessionStoreForTests,
  saveHandoff,
  sessionsRoot,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- handoffs

describe('handoff storage', () => {
  const handoff = (sessionId: string, id: string, createdAt: number) => ({
    id,
    sessionId,
    createdAt,
    model: 'deepseek/test',
    reasoning: 'medium',
    text: 'TASK — finish the thing',
    sourceEvents: 3,
    sourceTokens: 120,
    notes: []
  });

  it('saves, reads back and reports the newest across sessions', async () => {
    const older = await createSession({ title: 'older' });
    const newer = await createSession({ title: 'newer' });
    await saveHandoff(handoff(older.id, '2026-01-01-aaaaaaaa', 1000));
    await saveHandoff(handoff(newer.id, '2026-01-02-bbbbbbbb', 2000));
    await appendEvent(older.id, {
      time: 1000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-01-aaaaaaaa',
      chars: 23,
      reason: 'manual'
    });
    await appendEvent(newer.id, {
      time: 2000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-02-bbbbbbbb',
      chars: 23,
      reason: 'resume'
    });

    expect((await readHandoff(older.id, '2026-01-01-aaaaaaaa'))?.text).toContain('TASK');
    expect((await latestHandoff())?.id).toBe('2026-01-02-bbbbbbbb');
    expect((await getSession(newer.id))?.lastHandoffId).toBe('2026-01-02-bbbbbbbb');
    await deleteSession(older.id);
    await deleteSession(newer.id);
  });

  it('reports a durable handoff after restart even when meta.json missed its debounced projection', async () => {
    const summary = await createSession({ title: 'handoff crash recovery' });
    const handoffId = '2026-08-25-crash002';
    await saveHandoff(handoff(summary.id, handoffId, 3_000));
    await appendEvent(summary.id, {
      time: 3_000,
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars: 23,
      reason: 'manual'
    });

    const staleMeta = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
    ) as { lastHandoffId: string | null };
    expect(staleMeta.lastHandoffId).toBeNull();

    resetSessionStoreForTests();
    expect((await latestHandoff())?.id).toBe(handoffId);
    expect((await getSession(summary.id))?.lastHandoffId).toBe(handoffId);
    await deleteSession(summary.id);
  });

  it('finds the newest handoff even when its session is beyond the 5,000-folder maintenance cap', async () => {
    const seed = await createSession({ title: 'handoff catalog seed' });
    await flushSessions();
    const seedSummary = JSON.parse(await fs.readFile(path.join(sessionsRoot(), seed.id, 'meta.json'), 'utf8'));
    const seedStat = await fs.stat(path.join(sessionsRoot(), seed.id, 'meta.json'));
    resetSessionStoreForTests();

    const names = Array.from({ length: 5001 }, (_, index) => `handoff-${String(index).padStart(5, '0')}`);
    const targetId = names.at(-1)!;
    const handoffId = '2026-08-24-deadbeef';
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const realStat = fs.stat.bind(fs);
    const rootPath = sessionsRoot();
    const virtualNames = new Set(names);
    const virtualId = (file: string): string | null => {
      const parts = path.relative(rootPath, file).split(path.sep);
      return parts.length === 2 && virtualNames.has(parts[0]!) ? parts[0]! : null;
    };
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(
      (async (target: Parameters<typeof fs.stat>[0], ...args: unknown[]) => {
        const file = String(target);
        if (virtualId(file)) {
          if (path.basename(file) === 'meta.json') return seedStat;
          throw Object.assign(new Error('synthetic catalog has no message history'), { code: 'ENOENT' });
        }
        return (realStat as (...callArgs: unknown[]) => ReturnType<typeof fs.stat>)(target, ...args);
      }) as typeof fs.stat
    );
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(target) === rootPath) return names;
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = virtualId(file);
        if (path.basename(file) === 'meta.json' && id) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            updatedAt: id === targetId ? 20_000 : 10_000,
            lastHandoffId: id === targetId ? handoffId : null,
            lastHandoffAt: id === targetId ? 20_000 : null
          });
        }
        if (file === path.join(rootPath, targetId, 'handoffs', `${handoffId}.json`)) {
          return JSON.stringify(handoff(targetId, handoffId, 20_000));
        }
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );

    try {
      expect((await latestHandoff())?.id).toBe(handoffId);
      expect((await realReaddir(rootPath)).some(name => virtualNames.has(name))).toBe(false);
    } finally {
      readdirSpy.mockRestore();
      readSpy.mockRestore();
      statSpy.mockRestore();
      resetSessionStoreForTests();
      await deleteSession(seed.id);
    }
  }, 90_000);

  it('never age-prunes closed recordings, including sessions without a handoff', async () => {
    const stale = await createSession({ title: 'stale' });
    const kept = await createSession({ title: 'kept' });
    await saveHandoff(handoff(kept.id, '2026-01-03-cccccccc', Date.now()));
    await appendEvent(kept.id, {
      time: Date.now(),
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-03-cccccccc',
      chars: 23,
      reason: 'manual'
    });

    // Age both sessions past the retention window by rewriting their summaries. Flushed first: the test seam forgets state without writing meta.json.
    await flushSessions();
    resetSessionStoreForTests();
    const long = Date.now() - 90 * 24 * 3600_000;
    for (const id of [stale.id, kept.id]) {
      const metaPath = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, updatedAt: long }), 'utf8');
    }

    const removed = await pruneSessions(30);
    expect(removed).toBe(0);
    expect(await getSession(kept.id)).not.toBeNull();
    expect(await getSession(stale.id)).not.toBeNull();
    await deleteSession(stale.id);
    await deleteSession(kept.id);
  }, 90_000);

  it('does not scan or remove even an expired recording when asked through the legacy prune seam', async () => {
    const seed = await createSession({ title: 'retention catalog seed' });
    const seedSummary = await getSession(seed.id);
    expect(seedSummary).not.toBeNull();
    resetSessionStoreForTests();

    const names = Array.from({ length: 5001 }, (_, index) => `prune-${String(index).padStart(5, '0')}`);
    const targetId = names.at(-1)!;
    const recent = Date.now();
    const expired = recent - 90 * 24 * 3600_000;
    const rootPath = sessionsRoot();
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const realStat = fs.stat.bind(fs);
    const realRm = fs.rm.bind(fs);
    const removed: string[] = [];

    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        const location = String(target);
        if (location === rootPath) return names;
        if (path.basename(location) === 'messages' && path.basename(path.dirname(location)).startsWith('prune-')) return [];
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (id.startsWith('prune-') && file.endsWith('meta.json')) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            updatedAt: id === targetId ? expired : recent,
            endedAt: recent,
            conversationId: null,
            chatIds: [],
            lastHandoffId: null,
            lastHandoffAt: null,
            __historySeq: 0
          });
        }
        if (id.startsWith('prune-') && file.endsWith('messages.json')) return '{}';
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(
      (async (target: Parameters<typeof fs.stat>[0], ...args: unknown[]) => {
        const file = String(target);
        if (path.basename(path.dirname(file)).startsWith('prune-') && file.endsWith('events.jsonl')) {
          const error = Object.assign(new Error('synthetic missing journal'), { code: 'ENOENT' });
          throw error;
        }
        return (realStat as (...callArgs: unknown[]) => ReturnType<typeof fs.stat>)(target, ...args);
      }) as typeof fs.stat
    );
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(
      (async (target: Parameters<typeof fs.rm>[0], ...args: unknown[]) => {
        const id = path.basename(String(target));
        if (id.startsWith('prune-')) {
          removed.push(id);
          return;
        }
        return (realRm as (...callArgs: unknown[]) => ReturnType<typeof fs.rm>)(target, ...args);
      }) as typeof fs.rm
    );

    try {
      expect(await pruneSessions(30)).toBe(0);
      expect(removed).toEqual([]);
    } finally {
      rmSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
      readdirSpy.mockRestore();
      resetSessionStoreForTests();
      await deleteSession(seed.id);
    }
  // Keep the former pathological catalogue shape: the invariant is that no reader or remover is touched at all, regardless of how much expired history exists.
  }, 90_000);

  it('asks for user-authoritative handoffs up to the documented 30k-token ceiling', () => {
    const prompt = nativeHandoffPrompt();
    expect(prompt).toContain(DEFAULT_HANDOFF_PROMPT);
    expect(prompt).toMatch(/user's explicit instructions and final decisions/i);
    expect(prompt).toMatch(/10,000[–-]30,000 tokens/i);
    expect(prompt).toMatch(/shorter than 6,000 tokens may omit important history/i);
    expect(prompt).toMatch(/Never exceed 30,000 tokens/i);
    expect(prompt).toMatch(/observed failure.*likely cause.*correction.*verification/i);
    expect(prompt).toMatch(/NEXT STEPS/i);
    expect(prompt).toMatch(/OPEN ISSUES/i);
    expect(prompt).toMatch(/CHECKS AND EVIDENCE/i);
    expect(prompt).toMatch(/DONE AND VERIFIED/i);
  });

  it('keeps continuation framing code-owned around an editable handoff prompt', () => {
    const custom = 'CUSTOM HANDOFF POLICY: carry only the state needed for the next action.';
    const prompt = nativeHandoffPrompt('abcdefghijklmnop', false, custom);
    expect(prompt).toContain('[[NEURAFLOK-HANDOFF:abcdefghijklmnop]]');
    expect(prompt).toContain(custom);
    expect(prompt).not.toContain(DEFAULT_HANDOFF_PROMPT);
    expect(prompt).toContain('omit raw tool-call arguments and result bodies');
    expect(prompt).toContain('Your reply to this message must be the brief itself and nothing else');
    expect(prompt).toContain('no tool calls');
  });

  it('keeps the thorough default and applies shorter limits without conflicting size rules', () => {
    expect(nativeHandoffPrompt('token', true, DEFAULT_HANDOFF_PROMPT, 'thorough')).toBe(nativeHandoffPrompt('token', true));
    const short = nativeHandoffPrompt('token', true, DEFAULT_HANDOFF_PROMPT, 'short');
    expect(short).not.toMatch(/10,000[–-]30,000|10k[–-]30k|shorter than 6,000 tokens may omit|Never exceed 30,000/i);
    expect(short).toMatch(/target roughly 2,000–6,000 tokens/);
    expect(short).toContain('Length setting: target roughly 2,000–6,000 tokens and never exceed 6,000 tokens. This replaces any other length target in these instructions.');
    // Shorter settings keep the same decision and next-step requirements.
    expect(short).toMatch(/user's explicit instructions and final decisions/i);
    expect(short).toMatch(/NEXT STEPS/i);
    const standard = nativeHandoffPrompt('token', true, DEFAULT_HANDOFF_PROMPT, 'standard');
    expect(standard).toMatch(/target roughly 4,000–10,000 tokens/);
    expect(standard).toContain('never exceed 10,000');
    // An edited prompt has no default sentence to swap; the code-owned line still sets the length.
    const custom = 'Carry only the state needed for the next action. Aim for about 20,000 tokens.';
    const edited = nativeHandoffPrompt('token', true, custom, 'short');
    expect(edited).toContain(custom);
    expect(edited).toContain('This replaces any other length target in these instructions.');
  });

  it('honors the tool-detail setting in the handoff brief without claiming to erase seen history', () => {
    expect(nativeHandoffPrompt('token', false)).toContain('omit raw tool-call arguments and result bodies');
    expect(nativeHandoffPrompt('token', false)).toContain('not the history you already saw');
    expect(nativeHandoffPrompt('token', true)).not.toContain('omit raw tool-call arguments');
    expect(nativeHandoffPrompt('token', false)).toContain('interim updates');
  });
});
