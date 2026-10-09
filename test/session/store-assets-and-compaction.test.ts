import {
  appendEvent,
  autoCompactionReady,
  createSession,
  defaultConfig,
  endSession,
  flushSessions,
  fs,
  getSession,
  observeSessionModel,
  path,
  readAsset,
  reopenSession,
  resetSessionStoreForTests,
  saveConfig,
  sessionsRoot,
  writeAsset,
} from './context.js';
import { describe, expect, it } from 'vitest';

describe('session store', () => {
  it('stores assets once per content and refuses a malformed asset id', async () => {
      const summary = await createSession({ title: 'assets' });
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const first = await writeAsset(summary.id, png, 'image/png');
      const second = await writeAsset(summary.id, png, 'image/png');
      expect(second.id).toBe(first.id);
      expect(first.id.endsWith('.png')).toBe(true);

      const files = await fs.readdir(path.join(sessionsRoot(), summary.id, 'assets'));
      expect(files).toHaveLength(1);
      expect(await readAsset(summary.id, first.id)).toEqual(png);
      expect(await readAsset(summary.id, '../../../config.json')).toBeNull();
    });

  it('keeps the compaction exemption model-scoped even with Infinite Astra enabled', async () => {
      const base = defaultConfig();
      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
      try {
        const summary = await createSession({ title: 'Astra policy', conversationId: 'conv-astra' });
        await appendEvent(summary.id, {
          time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'astra-u',
          message: { text: 'x'.repeat(44_000), chars: 44_000, truncated: false }
        });
        expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
        await observeSessionModel(summary.id, 'conv-astra', 'GPT-6 Pro', 200);
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);
        // A delayed old receipt and a foreign document are neither the current selection.
        await observeSessionModel(summary.id, 'conv-astra', 'gpt-6-sol', 100);
        await observeSessionModel(summary.id, 'other-chat', 'gpt-6-sol', 300);
        await flushSessions();
        resetSessionStoreForTests();
        expect((await getSession(summary.id))?.selectedModel?.model).toBe('GPT-6 Pro');
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);
        await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-sol', 400);
        expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
        await saveConfig({ ...base, ui: { ...base.ui, finishTool: true }, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
        expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
        await observeSessionModel(summary.id, 'conv-astra', 'gpt-6-astra', 500);
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);
        await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-pro', 510);
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);
        await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-sol', 520, 'pro');
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);
        await observeSessionModel(summary.id, 'conv-astra', 'gpt-6', 530, 'pro');
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);
        await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-sol', 600);
        expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      } finally { await saveConfig(base); }
    });

  it('keeps automatic compaction ready above the line across interrupted and later turns', async () => {
      const base = defaultConfig();
      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
      try {
        const summary = await createSession({ title: 'auto level', conversationId: 'conv-auto-level' });
        await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 't-1' });
        await appendEvent(summary.id, {
          time: 2,
          source: 'extension',
          kind: 'user_message',
          messageId: 'u1',
          turnId: 't-1',
          message: { text: 'a'.repeat(44_000), truncated: false, chars: 44_000 }
        });
        expect(autoCompactionReady(await getSession(summary.id))).toBe(true);

        await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', turnId: 't-1', outcome: 'interrupted' });
        await appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_start', turnId: 't-2' });
        expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      } finally {
        await saveConfig(base);
      }
    });

  it('offers nothing while the switch is off or below the line', async () => {
      const base = defaultConfig();
      await saveConfig({ ...base, compaction: { ...base.compaction, auto: false, autoTokens: 10_000 } });
      try {
        const summary = await createSession({ title: 'off', conversationId: 'conv-auto-off' });
        await appendEvent(summary.id, {
          time: 1,
          source: 'extension',
          kind: 'user_message',
          messageId: 'u1',
          message: { text: 'a'.repeat(44_000), truncated: false, chars: 44_000 }
        });
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

        await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 4_000_000 } });
        expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

        await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
        expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      } finally {
        await saveConfig(base);
      }
    });

  it('keeps the level ready across a close and reopen so a later generation can retry', async () => {
      const base = defaultConfig();
      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
      try {
        const summary = await createSession({ title: 'reopened', conversationId: 'conv-auto-reopen' });
        await appendEvent(summary.id, {
          time: 1,
          source: 'extension',
          kind: 'user_message',
          messageId: 'u1',
          message: { text: 'r'.repeat(44_000), truncated: false, chars: 44_000 }
        });
        await endSession(summary.id);
        await reopenSession(summary.id);
        const reopened = await getSession(summary.id);
        expect(autoCompactionReady(reopened)).toBe(true);
      } finally {
        await saveConfig(base);
      }
    });
});
