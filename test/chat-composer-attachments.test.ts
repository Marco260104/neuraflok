import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import type { InputAttachment } from '../contracts/input.js';
import type { SessionSummary } from '../contracts/session.js';
import { createChatComposerAttachments, imageDrafts, waitForComposerAttachmentUploads } from '../frontend/features/chat/chat-composer-attachments.js';

it('shows a selected PDF as uploading, keeps its text draft editable, and updates when the provider confirms it', async () => {
  const dom = new JSDOM('<main><div id="composerImages"></div><div id="composer"></div><select id="webProvider"><option value="deepseek" selected>DeepSeek</option></select><textarea id="chatInput">Summarize this PDF</textarea></main>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousSelect = globalThis.HTMLSelectElement;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLSelectElement: dom.window.HTMLSelectElement });
  const projectId = '00000000-0000-4000-8000-000000000099';
  const sessionId = '2026-10-28-abcdef12';
  const file: InputAttachment = { id: '00000000-0000-4000-8000-000000000098', name: 'synthetic.pdf', size: 15, mimeType: 'application/pdf' };
  const session = { id: sessionId, projectId, conversationId: 'ds-00000000-0000-4000-8000-000000000097' } as SessionSummary;
  let selectedId: string | null = null;
  let selectedProjectId: string | null = projectId;
  let selectedKey = `project:${projectId}`;
  let generation = 0;
  let sessions: SessionSummary[] = [];
  const inputDrafts = new Map<string, string>([[selectedKey, 'Summarize this PDF']]);
  let finishUpload!: (reply: { ok: true; data: { sessionId: string; attachmentIds: string[]; ready: true } }) => void;
  const uploadReply = new Promise<{ ok: true; data: { sessionId: string; attachmentIds: string[]; ready: true } }>(resolve => { finishUpload = resolve; });
  const uploadProviderAttachments = vi.fn(() => uploadReply);
  const removeProviderAttachments = vi.fn(async () => ({ ok: true as const, data: { sessionId, attachmentIds: [file.id], removed: true as const } }));
  const api = {
    chooseFiles: vi.fn(), dropFiles: vi.fn(), attachText: vi.fn(),
    ensureAttachmentSession: vi.fn(async () => ({ ok: true as const, data: session })),
    uploadProviderAttachments,
    removeProviderAttachments
  } as unknown as Pick<typeof window.api, 'chooseFiles' | 'dropFiles' | 'attachText' | 'ensureAttachmentSession' | 'uploadProviderAttachments' | 'removeProviderAttachments'>;
  const textarea = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
  const controller = createChatComposerAttachments({
    api,
    draftKey: () => selectedKey,
    owner: () => ({ key: selectedKey, generation }),
    ownsOwner: owner => owner.key === selectedKey && owner.generation === generation,
    get selectedId() { return selectedId; },
    get selectedProjectId() { return selectedProjectId; },
    get sessions() { return sessions; },
    set sessions(value) { sessions = value; },
    inputDrafts,
    authoredComposerText: () => textarea.value,
    selectSession: id => {
      inputDrafts.set(selectedKey, textarea.value);
      selectedId = id;
      selectedProjectId = projectId;
      selectedKey = id;
      generation++;
      textarea.value = inputDrafts.get(id) ?? '';
    },
    paintSessions: vi.fn(),
    run: async promise => { const reply = await promise; return reply.ok ? reply.data : null; },
    attachmentCard: (_attachment, _inComposer, status) => {
      const card = dom.window.document.createElement('div');
      card.className = 'attachment-card';
      card.dataset.uploadStatus = status ?? '';
      return card;
    },
    paintDeliveryControls: vi.fn()
  });

  try {
    const owner = { key: selectedKey, generation };
    expect(controller.append(owner, [file])).toBe(true);
    expect(dom.window.document.querySelector('.attachment-card')?.getAttribute('data-upload-status')).toBe('uploading');
    for (let attempt = 0; attempt < 10 && !uploadProviderAttachments.mock.calls.length; attempt += 1) {
      await Promise.resolve();
    }
    expect(uploadProviderAttachments).toHaveBeenCalledOnce();
    expect(selectedId).toBe(sessionId);
    expect(textarea.value).toBe('Summarize this PDF');
    expect(imageDrafts.get(sessionId)).toContain(file);

    let ready = false;
    const waiting = waitForComposerAttachmentUploads([file]).then(value => { ready = value; });
    await Promise.resolve();
    expect(ready).toBe(false);
    finishUpload({ ok: true, data: { sessionId, attachmentIds: [file.id], ready: true } });
    await waiting;
    expect(ready).toBe(true);
    expect(dom.window.document.querySelector('.attachment-card')?.getAttribute('data-upload-status')).toBe('ready');
    (dom.window.document.querySelector('.image-remove') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(removeProviderAttachments).toHaveBeenCalledWith(sessionId, [file]));
    await vi.waitFor(() => expect(imageDrafts.get(sessionId)).not.toContain(file));
    expect(imageDrafts.get(sessionId)).not.toContain(file);
    expect(dom.window.document.querySelector('.attachment-card')).toBeNull();
  } finally {
    imageDrafts.delete(sessionId);
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, HTMLSelectElement: previousSelect });
    dom.window.close();
  }
});

it('removes a failed image upload locally so it cannot block the message draft', async () => {
  const dom = new JSDOM('<main><div id="composerImages"></div><div id="composer"></div><select id="webProvider"><option value="deepseek" selected>DeepSeek</option></select><textarea id="chatInput">Transcribe this image</textarea></main>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousSelect = globalThis.HTMLSelectElement;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLSelectElement: dom.window.HTMLSelectElement });
  const projectId = '00000000-0000-4000-8000-000000000199';
  const sessionId = '2026-10-29-failedimg';
  const file: InputAttachment = { id: '00000000-0000-4000-8000-000000000198', name: 'synthetic.png', size: 15, mimeType: 'image/png' };
  const session = { id: sessionId, projectId, conversationId: 'ds-00000000-0000-4000-8000-000000000197' } as SessionSummary;
  let selectedId: string | null = sessionId;
  let selectedProjectId: string | null = projectId;
  let selectedKey = sessionId;
  let generation = 0;
  let sessions: SessionSummary[] = [session];
  const inputDrafts = new Map<string, string>();
  const uploadProviderAttachments = vi.fn(async () => ({ ok: false as const, error: 'DeepSeek did not confirm the upload.' }));
  const removeProviderAttachments = vi.fn();
  const api = {
    chooseFiles: vi.fn(), dropFiles: vi.fn(), attachText: vi.fn(),
    ensureAttachmentSession: vi.fn(async () => ({ ok: true as const, data: session })),
    uploadProviderAttachments,
    removeProviderAttachments
  } as unknown as Pick<typeof window.api, 'chooseFiles' | 'dropFiles' | 'attachText' | 'ensureAttachmentSession' | 'uploadProviderAttachments' | 'removeProviderAttachments'>;
  const textarea = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
  const controller = createChatComposerAttachments({
    api,
    draftKey: () => selectedKey,
    owner: () => ({ key: selectedKey, generation }),
    ownsOwner: owner => owner.key === selectedKey && owner.generation === generation,
    get selectedId() { return selectedId; },
    get selectedProjectId() { return selectedProjectId; },
    get sessions() { return sessions; },
    set sessions(value) { sessions = value; },
    inputDrafts,
    authoredComposerText: () => textarea.value,
    selectSession: id => { selectedId = id; selectedProjectId = projectId; selectedKey = id; generation++; },
    paintSessions: vi.fn(),
    run: async promise => { const reply = await promise; return reply.ok ? reply.data : null; },
    attachmentCard: (_attachment, _inComposer, status) => {
      const card = dom.window.document.createElement('div');
      card.className = 'attachment-card';
      card.dataset.uploadStatus = status ?? '';
      return card;
    },
    paintDeliveryControls: vi.fn()
  });

  try {
    const owner = { key: selectedKey, generation };
    expect(controller.append(owner, [file])).toBe(true);
    await vi.waitFor(() => expect(dom.window.document.querySelector('.attachment-card')?.getAttribute('data-upload-status')).toBe('failed'));
    expect(textarea.value).toBe('Transcribe this image');
    (dom.window.document.querySelector('.image-remove') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(imageDrafts.get(sessionId)).not.toContain(file));
    expect(removeProviderAttachments).not.toHaveBeenCalled();
    expect(dom.window.document.querySelector('.attachment-card')).toBeNull();
    await expect(waitForComposerAttachmentUploads([file])).resolves.toBe(true);
    expect(textarea.value).toBe('Transcribe this image');
  } finally {
    imageDrafts.delete(sessionId);
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, HTMLSelectElement: previousSelect });
    dom.window.close();
  }
});

it('serializes a second file behind the first when the draft moves into its new session', async () => {
  const dom = new JSDOM('<main><div id="composerImages"></div><div id="composer"></div><select id="webProvider"><option value="deepseek" selected>DeepSeek</option></select><textarea id="chatInput">Read both files</textarea></main>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousSelect = globalThis.HTMLSelectElement;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLSelectElement: dom.window.HTMLSelectElement });
  const projectId = '00000000-0000-4000-8000-000000000109';
  const sessionId = '2026-10-29-abcdef12';
  const first: InputAttachment = { id: '00000000-0000-4000-8000-000000000101', name: 'first.pdf', size: 15, mimeType: 'application/pdf' };
  const second: InputAttachment = { id: '00000000-0000-4000-8000-000000000102', name: 'second.pdf', size: 15, mimeType: 'application/pdf' };
  const session = { id: sessionId, projectId, conversationId: 'ds-00000000-0000-4000-8000-000000000103' } as SessionSummary;
  type UploadReply = { ok: true; data: { sessionId: string; attachmentIds: string[]; ready: true } };
  const uploadResolvers: Array<(reply: UploadReply) => void> = [];
  let selectedId: string | null = null;
  let selectedProjectId: string | null = projectId;
  let selectedKey = `project:${projectId}`;
  let generation = 0;
  let sessions: SessionSummary[] = [];
  const inputDrafts = new Map<string, string>([[selectedKey, 'Read both files']]);
  const uploadProviderAttachments = vi.fn((_id: string, _files: InputAttachment[]) => new Promise<UploadReply>(resolve => { uploadResolvers.push(resolve); }));
  const removeProviderAttachments = vi.fn();
  const api = {
    chooseFiles: vi.fn(), dropFiles: vi.fn(), attachText: vi.fn(),
    ensureAttachmentSession: vi.fn(async () => ({ ok: true as const, data: session })),
    uploadProviderAttachments,
    removeProviderAttachments
  } as unknown as Pick<typeof window.api, 'chooseFiles' | 'dropFiles' | 'attachText' | 'ensureAttachmentSession' | 'uploadProviderAttachments' | 'removeProviderAttachments'>;
  const textarea = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
  const controller = createChatComposerAttachments({
    api,
    draftKey: () => selectedKey,
    owner: () => ({ key: selectedKey, generation }),
    ownsOwner: owner => owner.key === selectedKey && owner.generation === generation,
    get selectedId() { return selectedId; },
    get selectedProjectId() { return selectedProjectId; },
    get sessions() { return sessions; },
    set sessions(value) { sessions = value; },
    inputDrafts,
    authoredComposerText: () => textarea.value,
    selectSession: id => { selectedId = id; selectedProjectId = projectId; selectedKey = id; generation++; },
    paintSessions: vi.fn(),
    run: async promise => { const reply = await promise; return reply.ok ? reply.data : null; },
    attachmentCard: (_attachment, _inComposer, status) => {
      const card = dom.window.document.createElement('div');
      card.className = 'attachment-card';
      card.dataset.uploadStatus = status ?? '';
      return card;
    },
    paintDeliveryControls: vi.fn()
  });

  try {
    controller.append({ key: selectedKey, generation }, [first]);
    await vi.waitFor(() => expect(uploadProviderAttachments).toHaveBeenCalledOnce());
    expect(selectedId).toBe(sessionId);
    controller.append({ key: selectedKey, generation }, [second]);
    await Promise.resolve();
    expect(uploadProviderAttachments).toHaveBeenCalledOnce();
    expect(imageDrafts.get(sessionId)?.map(file => file.name)).toEqual(['first.pdf', 'second.pdf']);

    uploadResolvers[0]!({ ok: true, data: { sessionId, attachmentIds: [first.id], ready: true } });
    await vi.waitFor(() => expect(uploadProviderAttachments).toHaveBeenCalledTimes(2));
    expect(uploadProviderAttachments.mock.calls[0]?.[1]).toEqual([first]);
    expect(uploadProviderAttachments.mock.calls[1]?.[1]).toEqual([second]);
    uploadResolvers[1]!({ ok: true, data: { sessionId, attachmentIds: [second.id], ready: true } });
    await expect(waitForComposerAttachmentUploads([first, second])).resolves.toBe(true);
  } finally {
    imageDrafts.delete(sessionId);
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, HTMLSelectElement: previousSelect });
    dom.window.close();
  }
});
