import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../contracts/session.js';
import { WEB_PROVIDERS, WEB_PROVIDER_IDS, webProviderConversationId } from '../contracts/web-providers.js';

const electron = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const store = vi.hoisted(() => ({ getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn() }));
const files = vi.hoisted(() => ({ writeFile: vi.fn(async () => undefined) }));
vi.mock('electron', () => electron);
vi.mock('../backend/domains/sessions/history/store.js', () => store);
vi.mock('node:fs', () => ({ promises: files }));

const { exportSessionMarkdown } = await import('../backend/infrastructure/desktop-shell/session-markdown-export.js');

const events: SessionEvent[] = [
  { seq: 1, time: 1, source: 'extension', kind: 'user_message', turnId: 't1', messageId: 'u1', message: { text: 'Explain it', truncated: false, chars: 10 } },
  { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'a1', final: true, state: 'final',
    message: { text: 'The first part', truncated: true, chars: 40, assetId: 'abcdef12.txt' } },
  { seq: 3, time: 3, source: 'extension', kind: 'turn_end', turnId: 't1', outcome: 'completed' }
] as SessionEvent[];

beforeEach(() => {
  vi.clearAllMocks();
  store.getSession.mockResolvedValue({ id: 'session-1', title: 'Explain: it?' });
  store.readEvents.mockResolvedValue(events);
  store.readOverflowText.mockResolvedValue('The first part, and the rest of the answer.');
});

it('copies a completed answer whole, reading the part the log cut', async () => {
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null)).resolves.toEqual({ done: 'copied' });
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('The first part, and the rest of the answer.\n');
});

it('saves the session transcript where the person chooses, named after the chat', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/Explain it.md' });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'session', target: 'file' }, null)).resolves.toEqual({ done: 'saved', name: 'Explain it.md' });
  expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toMatchObject({ defaultPath: expect.stringContaining('Explain it.md') });
  expect(files.writeFile).toHaveBeenCalledWith('/downloads/Explain it.md',
    '# Explain: it?\n\n## You\n\nExplain it\n\n## Assistant\n\nThe first part, and the rest of the answer.\n', 'utf8');
});

it.each(WEB_PROVIDER_IDS)('labels a %s transcript with its provider name', async provider => {
  const conversationId = webProviderConversationId(provider, '12345678-1234-1234-1234-123456789abc');
  store.getSession.mockResolvedValueOnce({ id: 'session-1', title: 'Explain: it?', conversationId });
  await exportSessionMarkdown({ id: 'session-1', scope: 'session', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(`## ${WEB_PROVIDERS[provider].label}\n\nThe first part, and the rest of the answer.`));
});

it('labels OpenAI API transcripts without presenting them as a browser chat', async () => {
  const conversationId = 'api-session-12345678';
  store.getSession.mockResolvedValueOnce({
    id: 'session-1', title: 'Explain: it?', conversationId,
    selectedModel: { conversationId, model: 'gpt-5', observedAt: 1, apiProvider: { kind: 'openai', baseUrl: 'https://api.openai.com/v1' } }
  });
  await exportSessionMarkdown({ id: 'session-1', scope: 'session', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('## OpenAI API\n\nThe first part, and the rest of the answer.'));
});

it('writes nothing when the save dialog is cancelled, and refuses unfinished turns', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'file' }, null)).resolves.toEqual({ done: 'cancelled' });
  expect(files.writeFile).not.toHaveBeenCalled();
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 'open-turn', target: 'clipboard' }, null)).rejects.toThrow('has not completed');
});
