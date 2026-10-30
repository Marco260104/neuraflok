import { expect, it, vi } from 'vitest';
import { prependUserPrompt } from "../../contracts/messaging/provider-message-envelope.js";
import type { SessionEvent } from "../../contracts/session.js";
import type { InputEntry } from "../../backend/domains/sessions/input/input.js";

import { T0, boot, settle, summary, text, toolCall } from './context.js';

it('shows a PDF loading badge in the sent bubble while keeping the composer usable', async () => {
  const file = { id: '00000000-0000-4000-8000-000000000001', name: 'scan.pdf', size: 42, mimeType: 'application/pdf' };
  const app = await boot([{
    seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'upload-message', inputId: 'upload-input',
    authoredText: 'Describe the scanned PDF.', attachments: [file], attachmentUpload: 'uploading',
    message: text('Describe the scanned PDF.')
  }]);
  const status = app.w.document.querySelector('.attachment-upload-status')!;
  expect(status.classList.contains('is-uploading')).toBe(true);
  expect(status.textContent).toContain('Uploading');
  expect(status.getAttribute('aria-live')).toBe('polite');

  const composer = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = app.w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(composer.disabled).toBe(false);
  composer.value = 'A follow-up typed during the upload';
  composer.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  await settle();
  expect(composer.value).toBe('A follow-up typed during the upload');
  expect(send.disabled).toBe(false);
  expect(send.dataset.action).toBe('send');
});

it('keeps canonical image attachments above the user text bubble for the selected session', async () => {
  const app = await boot([]);
  const { w } = app;
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:one', inputId: 'one', message: text('Inspect this'), assets: [{ id: 'abcdef.bin', mimeType: 'image/webp', bytes: 12 }] };
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/webp;base64,YQ==' }));
  // Match the real IPC result envelope used by this harness.
  (w as any).api.getSessionImage = getImage;
  await app.append([message]);
  const attachments = w.document.querySelector('.message-attachments')!;
  expect(attachments.tagName).toBe('DIV');
  expect(attachments.querySelector('summary')).toBeNull();
  expect(attachments.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  await settle();
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdef.bin');
  expect(attachments.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,YQ==');
});

it('reserves every saved user-image slot before IPC and keeps missing previews inside their slots', async () => {
  const app = await boot([]);
  const pending: Array<(value: unknown) => void> = [];
  (app.w as any).api.getSessionImage = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'two-images',
    message: text('Inspect both'), assets: ['one.webp', 'two.webp'].map(id => ({ id, mimeType: 'image/webp', bytes: 12 })) }]);
  const attachments = app.w.document.querySelector('.message-attachments')!;
  const slots = [...attachments.querySelectorAll('.user-image-slot')];
  expect(slots).toHaveLength(2);
  expect(attachments.children).toHaveLength(2);
  pending[0]!({ ok: true, data: null }); await settle();
  expect(slots[0]!.textContent).toContain('Image unavailable');
  pending[1]!({ ok: true, data: 'data:image/webp;base64,YQ==' }); await settle();
  expect(slots[1]!.querySelector('img')).not.toBeNull();
  expect([...attachments.children]).toEqual(slots);
});

it('keeps a retained fallback and its unsaved notice inside the reserved user-image footprint', async () => {
  const app = await boot([]);
  const dataUrl = 'data:image/webp;base64,YQ==';
  app.live.inputs.push({ id: 'fallback-input', sessionId: summary([]).id, state: 'sent', owner: null,
    text: 'Fallback', mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0,
    conversationId: 'chat-b', messageId: 'fallback-message', toolImages: [{ name: 'fallback.webp', dataUrl }] });
  (app.w as any).api.getSessionImage = vi.fn(async () => ({ ok: true, data: null }));
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'fallback-message',
    inputId: 'fallback-input', message: text('Fallback'), assets: [{ id: 'missing.webp', mimeType: 'image/webp', bytes: 12 }] }]);
  const attachments = app.w.document.querySelector('.message-attachments')!;
  expect(attachments.children).toHaveLength(1);
  const slot = attachments.firstElementChild!;
  expect(slot.className).toBe('user-image-slot');
  expect(slot.querySelector('img')?.getAttribute('src')).toBe(dataUrl);
  expect(slot.querySelector('.retained-image-notice')?.textContent).toBe('Not saved to history');
});

it.each([false, true])('keeps retained image previews at the canonical row across queue/history arrival and off-tail reload (historyFirst=%s)', async historyFirst => {
  const app = await boot([]);
  const { w, live, append } = app;
  const row: InputEntry = { id: 'image-input', sessionId: summary([]).id, state: 'sent', owner: null, text: 'Original image request',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, deliveredAt: T0 + 10, conversationId: 'chat-b',
    messageId: 'input:image-input', historyRecorded: false, historyAnchored: true,
    toolImages: [{ name: 'retained.webp', dataUrl: 'data:image/webp;base64,YQ==' }] };
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: row.messageId,
    inputId: row.id, inputDelivery: 'confirmed', message: text(row.text) };
  if (historyFirst) await append([message]);
  live.inputs.push(row);
  await append(historyFirst ? [] : [message]);
  expect(w.document.querySelectorAll('#timeline .said.is-user img')).toHaveLength(1);
  expect(w.document.querySelector('#timeline .said.is-user img')?.getAttribute('src')).toBe(row.toolImages![0]!.dataUrl);
  const retainedNotice = w.document.querySelector('#timeline .retained-image-notice')!;
  expect(retainedNotice.textContent).toBe('Not saved to history');
  expect(retainedNotice.parentElement?.className).toBe('user-image-slot');
  expect(retainedNotice.previousElementSibling?.tagName).toBe('IMG');
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain(row.text);
  // Queue changes must repaint the same canonical row, never borrow another owner.
  live.inputs[0] = { ...row, sessionId: 'another-session' };
  await append([]);
  expect(w.document.querySelector('#timeline .said.is-user img')).toBeNull();
  live.inputs[0] = row; await append([]);
  const api = (w as any).api;
  api.getSessionImage = vi.fn(async () => ({ ok: true, data: row.toolImages![0]!.dataUrl }));
  await append([{ ...message, seq: 2, origin: 1, assets: [{ id: 'saved.webp', mimeType: 'image/webp', bytes: 1 }] }]);
  expect(w.document.querySelectorAll('#timeline .said.is-user img')).toHaveLength(1);
  expect(w.document.querySelector('#timeline .retained-image-notice')).toBeNull();
  await append(Array.from({ length: 180 }, (_, i): SessionEvent => ({ seq: i + 3, time: T0 + i + 20, kind: 'user_message',
    source: 'extension', messageId: `newer-${i}`, message: text(`Newer ${i}`) })));
  const original = api.getSession;
  api.getSession = async (id: string, options: any) => {
    const result = await original(id, options);
    if (options?.from === undefined && options?.before === undefined) result.data.events = result.data.events.slice(-160);
    return result;
  };
  w.document.getElementById('newChat')!.click(); await settle();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(w.document.querySelector('#timeline')!.textContent).not.toContain(row.text);
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain(row.text);
});

it.each([false, true])('hands a delivered bubble to exact native history without a blank or duplicate (historyFirst=%s)', async historyFirst => {
  const { w, live, append } = await boot([]);
  const row: InputEntry = { id: 'delivery-one', sessionId: summary([]).id, state: 'browser', owner: 'page', text: 'Follow-up once',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, conversationId: 'chat-b' };
  live.inputs.push(row); await append([]);
  const original = w.document.querySelector('#inputQueue .pending-message');
  await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')).toBe(original);
  const message: SessionEvent = { seq: 1, time: T0 + 1, source: 'app', kind: 'user_message', messageId: 'native-followup',
    inputId: row.id, message: text(row.text) };
  if (historyFirst) await append([message]);
  else {
    live.inputs[0] = { ...row, state: 'sent', messageId: 'native-followup', historyAnchored: true, deliveredAt: T0 + 1 };
    await append([]);
  }
  const count = () => [...w.document.querySelectorAll('#timeline .said.is-user, #inputQueue .pending-message')].filter(node => node.textContent?.includes(row.text)).length;
  expect(count()).toBe(1);
  if (historyFirst) live.inputs[0] = { ...row, state: 'sent', messageId: 'native-followup', historyAnchored: true, deliveredAt: T0 + 1 };
  await append(historyFirst ? [] : [message]);
  expect(count()).toBe(1);
  expect(w.document.querySelector('#inputQueue .pending-message')).toBeNull();
});

it.each([undefined, 4])('never resurrects committed off-page inputs beside genuinely waiting inputs when old timestamps reappear (historySeq=%s)', async historySeq => {
  const events = Array.from({ length: 180 }, (_, i): SessionEvent => ({ ...toolCall(i + 10, `receipt-${i}`), time: T0 - 100 }));
  const { w, live, append } = await boot(events);
  const base = { sessionId: summary([]).id, owner: null, mode: 'auto' as const, model: null, reasoningEffort: null,
    dueAt: T0, createdAt: T0, conversationId: 'chat-b' };
  live.inputs.push({ ...base, id: 'old-delivered', text: 'Already delivered correction', state: 'sent',
    messageId: 'input:old-delivered', deliveredAt: T0 + 20, historyAnchored: true, historyRecorded: true, historySeq },
    { ...base, id: 'still-waiting', text: 'Genuinely waiting correction', state: 'queued' },
    { ...base, id: 'history-in-flight', text: 'Receipt preceding history snapshot', state: 'sent',
      messageId: 'input:history-in-flight', deliveredAt: T0 + 30, historyAnchored: true, historySeq: 200 });
  for (let i = 0; i < 2; i++) {
    await append([]);
    const queue = w.document.querySelector('#inputQueue')!;
    expect(queue.textContent).not.toContain('Already delivered correction');
    expect(queue.textContent).toContain('Genuinely waiting correction');
    expect(queue.textContent).toContain('Receipt preceding history snapshot');
  }
  await append([{ seq: 200, origin: 200, time: T0 + 30, kind: 'user_message', source: 'app',
    inputId: 'history-in-flight', messageId: 'input:history-in-flight', message: text('Receipt preceding history snapshot') }]);
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain('Receipt preceding history snapshot');
  expect(w.document.querySelector('#timeline')!.textContent).toContain('Receipt preceding history snapshot');
});

it('does not request conversation-only controls for a local chat without a provider binding', async () => {
  const reserved = { ...summary([]), conversationId: null, chatIds: [], origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
  const { w, append } = await boot([], true, [], [], { sessions: [reserved] });
  const controls = vi.fn(async () => ({ ok: false, error: 'session_not_recorded' }));
  (w as any).api.getSessionControls = controls;
  await append([]); await append([]);
  expect(controls).not.toHaveBeenCalled();
  expect(w.document.getElementById('compactSession')!.hidden).toBe(true);
});

it('removes a withdrawn newest chat after sidebar pagination while preserving the older page', async () => {
  const opening = { ...summary([]), id: 'reserved-opening', title: 'Withdrawn', updatedAt: T0 + 3,
    conversationId: null, chatIds: [], origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
  const retained = { ...summary([]), id: 'retained-chat', updatedAt: T0 + 2 };
  const older = { ...summary([]), id: 'older-chat', updatedAt: T0 + 1 };
  const { w, append } = await boot([], false, [], [], { sessions: [opening, retained] });
  let withdrawn = false, complete = false;
  (w as any).api.listSessions = async (options: any) => ({ ok: true, data: {
    sessions: options?.cursor ? [older] : withdrawn ? [retained] : [opening, retained],
    total: complete ? 1 : withdrawn ? 2 : 3, nextCursor: options?.cursor || complete ? null : { updatedAt: retained.updatedAt, id: retained.id },
    activeId: null, pressure: [], blocked: []
  } });
  await append([]);
  w.document.getElementById('sessionList')!.closest('.scroll')!.dispatchEvent(new w.Event('scroll'));
  await settle();
  expect(w.document.querySelector('[data-id="older-chat"]')).not.toBeNull();
  withdrawn = true; await append([]);
  expect(w.document.querySelector('[data-id="reserved-opening"]')).toBeNull();
  expect(w.document.querySelector('[data-id="older-chat"]')).not.toBeNull();
  complete = true; await append([]);
  expect(w.document.querySelector('[data-id="older-chat"]')).toBeNull();
  expect(w.document.querySelector('[data-id="retained-chat"]')).not.toBeNull();
});

it('reserves geometry and hydrates multiple native generated images independently in source order', async () => {
  const app = await boot([]);
  const { w } = app;
  const pending = new Map<string, (value: unknown) => void>();
  (w as any).api.getSessionImage = vi.fn((_sessionId: string, assetId: string) => new Promise(resolve => pending.set(assetId, resolve)));
  const messageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
  const events: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'native_image', messageId,
      providerAssetId: 'file_blue', providerRole: 'tool', providerChannel: 'final', width: 1254, height: 1254,
      previewStatus: 'available', previewWidth: 12, previewHeight: 12, asset: { id: 'blue.webp', mimeType: 'image/webp', bytes: 12 } },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'native_image', messageId,
      providerAssetId: 'file_orange', providerRole: 'tool', providerChannel: 'final', width: 1024, height: 768,
      previewStatus: 'available', previewWidth: 16, previewHeight: 12, asset: { id: 'orange.webp', mimeType: 'image/webp', bytes: 12 } }
  ];
  await app.append(events);

  const rows = [...w.document.querySelectorAll<HTMLElement>('.said.native-image')];
  expect(rows).toHaveLength(2);
  expect(w.document.querySelectorAll('.generated-image-gallery')).toHaveLength(1);
  expect(w.document.querySelector('.generated-image-gallery')?.querySelectorAll('.ev-native_image')).toHaveLength(2);
  const frames = rows.map(row => row.querySelector<HTMLElement>('.generated-image-frame')!);
  expect(frames.map(frame => frame.style.aspectRatio)).toEqual(['1254 / 1254', '1024 / 768']);
  expect(frames.every(frame => frame.textContent === 'Image preview is loading')).toBe(true);

  pending.get('orange.webp')?.({ ok: true, data: 'data:image/webp;base64,b3Jhbmdl' });
  await settle();
  expect(frames[1]!.querySelector('img')?.getAttribute('src')).toContain('b3Jhbmdl');
  expect(frames[0]!.querySelector('img')).toBeNull();
  pending.get('blue.webp')?.({ ok: true, data: 'data:image/webp;base64,Ymx1ZQ==' });
  await settle();
  expect(frames[0]!.querySelector('img')?.getAttribute('src')).toContain('Ymx1ZQ==');
});

it('keeps generated-image metadata visible when recording storage is full', async () => {
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'native_image',
    messageId: '5150f756-bf2d-45fa-ac0f-45010b2239fb', providerAssetId: 'file_quota_fixture',
    providerRole: 'tool', providerChannel: 'final', providerStatus: 'finished_successfully',
    width: 1254, height: 1254, previewStatus: 'unavailable', previewError: 'quota' }]);
  const row = app.w.document.querySelector('.said.native-image')!;
  expect(row.textContent).toContain('recording storage is full');
  expect(row.querySelector('.generated-image-frame')).toBeTruthy();
  expect(row.querySelector('img')).toBeNull();
  expect(row.querySelector('.generated-image-frame')?.classList.contains('is-unavailable')).toBe(true);
  expect(row.querySelector('button')?.textContent).toBe('Free image storage');
});

it('does not group images across an intervening authored message or another turn', async () => {
  const app = await boot([]);
  const image = (seq: number, turnId: string): SessionEvent => ({ seq, time: T0 + seq,
    source: 'extension', kind: 'native_image', messageId: `image-${seq}`, providerAssetId: `file-${seq}`,
    providerRole: 'tool', turnId, previewStatus: 'pending' });
  await app.append([image(1, 'a'), image(2, 'a'),
    { seq: 3, time: T0 + 3, source: 'extension', kind: 'assistant_message', messageId: 'text-3',
      turnId: 'a', final: false, message: { text: 'Between images', chars: 14, truncated: false } },
    image(4, 'a'), image(5, 'b')]);
  const galleries = [...app.w.document.querySelectorAll('.generated-image-gallery')];
  expect(galleries.map(gallery => gallery.querySelectorAll('.ev-native_image').length)).toEqual([2, 1, 1]);
  expect(galleries[0]?.nextElementSibling?.textContent).toContain('Between images');
});

it('retains one exact-message gallery when only one image gains a proven turn', async () => {
  const app = await boot([]);
  const first: SessionEvent = { seq: 1, time: T0, source: 'extension', kind: 'native_image',
    messageId: 'shared-image-message', providerAssetId: 'file-one', providerRole: 'tool', previewStatus: 'pending' };
  await app.append([first, { ...first, seq: 2, time: T0 + 1, providerAssetId: 'file-two' }]);
  const gallery = app.w.document.querySelector('.generated-image-gallery');
  await app.append([{ ...first, seq: 3, origin: 1, turnId: 'proven-turn', previewStatus: 'unavailable', previewError: 'quota' }]);
  expect(app.w.document.querySelectorAll('.generated-image-gallery')).toHaveLength(1);
  expect(app.w.document.querySelector('.generated-image-gallery')).toBe(gallery);
  expect(gallery?.querySelectorAll('.ev-native_image')).toHaveLength(2);
});

it('shows a native image-only message immediately as a card without a guessed caption or image fetch', async () => {
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'native-image-only',
    message: text(''), attachments: [{ id: 'native-provider-file', name: 'example.png', size: 123, mimeType: 'image/png' }] }]);
  const row = app.w.document.querySelector('.said.is-user')!;
  expect(row.querySelector('.attachment-card')?.textContent).toContain('example.png');
  expect(row.querySelector('.user-message-text')).toBeNull();
  expect(row.querySelector('img')).toBeNull();
});

it.each(['image', 'txt', 'mixed', 'new-chat', 'after-turn'])('routes the composer attachment action truthfully (%s)', async kind => {
  const app = await boot([], kind !== 'new-chat');
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  const files = kind === 'txt' ? [txt] : kind === 'mixed' ? [image, txt] : [image];
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: files });
  if (kind === 'new-chat') {
    const uploadedSession = {
      ...summary([]), id: '2026-09-02-upload0001', conversationId: 'ds-00000000-0000-4000-8000-000000000111',
      projectId: null, chatIds: [], title: 'Attachment upload'
    };
    const getSessionControls = (app.w as any).api.getSessionControls;
    (app.w as any).api.ensureAttachmentSession = async () => ({ ok: true, data: uploadedSession });
    (app.w as any).api.getSessionControls = async (id: string) => {
      const result = await getSessionControls(id);
      return id === uploadedSession.id
        ? { ...result, data: { ...result.data, sessionId: id, conversationId: uploadedSession.conversationId, activeTurnId: null, canInject: false } }
        : result;
    };
    (app.w as any).api.uploadProviderAttachments = async (sessionId: string, attachments: typeof files) => ({
      ok: true, data: { sessionId, attachmentIds: attachments.map(file => file.id), ready: true }
    });
  }
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe(
    kind === 'new-chat' ? 'Send' : ['txt', 'mixed'].includes(kind) ? 'After this turn' : 'Inject now');
  if (kind === 'after-turn') (app.w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(app.live.sent).toHaveLength(1);
  expect(app.live.sent[0]).toMatchObject({ text: 'Please look at the attached files.', attachments: files });
  expect(app.live.sent[0]!.attachmentDelivery).toBe(kind === 'image' ? 'tool' : undefined);
});

it('restores the image draft after rejected injection and removes native-only delivery when the document is removed', async () => {
  const app = await boot([]);
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  (app.w as any).api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id, activeTurnId: 'held-turn', canInject: true, queueAtFinish: true } });
  await app.append([]);
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: [image, txt] });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('afterTurnLabel')!.textContent).toBe('After this turn');
  expect(app.w.document.getElementById('queueAtFinish')!.hidden).toBe(true);
  (app.w.document.querySelector('[aria-label="Remove notes.txt"]') as HTMLButtonElement).click();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe('Inject now');
  (app.w as any).api.sendInput = async () => ({ ok: false, error: 'Image is too large for injection' });
  const field = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  field.value = 'Use the original image';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(field.value).toBe('Use the original image');
  expect(app.w.document.querySelectorAll('#composerImages .image-remove')).toHaveLength(1);
  expect(app.w.document.querySelector('[aria-label="Remove image.png"]')).not.toBeNull();
});

it.each([7, 10, 11])('uses the same visible delivery choice and payload for %s attached images', async count => {
  const { w, live } = await boot([]);
  const files = Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`, name: `image-${index}.png`, mimeType: 'image/png', size: 42
  }));
  (w as any).api.chooseFiles = async () => ({ ok: true, data: files });
  w.document.getElementById('attachImages')!.click(); await settle();
  const inject = w.document.querySelector<HTMLElement>('[data-delivery="tool"]')!;
  expect(inject.hidden).toBe(count > 10);
  expect(w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe(count > 10 ? 'After this turn' : 'Inject now');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]?.attachments).toEqual(files);
  expect(live.sent[0]?.delivery).toBe(count > 10 ? undefined : 'tool');
});

it('uses the same separate image row for pending and recorded native attachments', async () => {
  const app = await boot([]);
  const attachment = { id: 'a'.repeat(32), name: 'meme.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  app.live.inputs.push({ id: 'image-input', sessionId: summary([]).id, text: 'whats that', attachments: [attachment],
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'browser', owner: null, createdAt: T0, conversationId: 'chat-b' });
  await app.append([]);
  const pending = app.w.document.querySelector('.pending-message')!;
  expect(pending.querySelector('.message-attachments')?.nextElementSibling?.className).toBe('pending-message-text');
  expect(pending.querySelector('.composer-image')).toBeNull();
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-image',
    inputId: 'image-input', message: text('whats that'), attachments: [attachment] }]);
  const recorded = app.w.document.querySelector('.said.is-user')!;
  expect(recorded.querySelector('.message-attachments')?.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  expect(recorded.querySelector('.message-attachments .attachment-image-card > img')?.getAttribute('alt')).toBe('meme.png');
  expect(recorded.querySelector('.composer-image')).toBeNull();
});

it('keeps all ten injected image previews when the outbox message gains its canonical history row', async () => {
  const { w, live, append } = await boot([]);
  const images = Array.from({ length: 10 }, (_, index) => ({ name: `reference-${index}.webp`, dataUrl: 'data:image/webp;base64,YQ==' }));
  live.inputs.push({ id: 'ten-images', sessionId: summary([]).id, text: 'Ten references', images, mode: 'auto', dueAt: 0,
    state: 'tool', owner: 'request', createdAt: 0, conversationId: 'chat-b', model: null, reasoningEffort: null });
  await append([]);
  expect(w.document.querySelectorAll('#inputQueue [data-input-id="ten-images"] img')).toHaveLength(10);
  await append([{ seq: 1, source: 'app', time: T0, kind: 'user_message', inputId: 'ten-images', messageId: 'input:ten-images', message: text('Ten references') }]);
  expect(w.document.querySelectorAll('#timeline .user-image-slot img')).toHaveLength(10);
  expect(w.document.querySelector('#inputQueue [data-input-id="ten-images"]')).toBeNull();
});

it('explains a legacy missing image recording without asserting a provider receipt', async () => {
  const app = await boot([]);
  const event = toolCall(1, 'missing-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'view_image';
  event.call.result = text('');
  await app.append([event]);
  const tool = app.w.document.querySelector('details.tool') as HTMLDetailsElement;
  tool.open = true; tool.dispatchEvent(new app.w.Event('toggle'));
  await settle();
  expect(tool.textContent).toContain('No image preview was retained in this recording.');
  expect(tool.textContent).not.toContain('received');
});

it('loads recorded tool images on expansion and hides truncated binary envelopes', async () => {
  const app = await boot([]);
  const { w } = app;
  const event = toolCall(1, 'plugin-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'get_viewport_screenshot';
  event.call.result = { text: '{"content":[{"type":"image","data":"AAAA', truncated: true, chars: 140000, assetId: 'aaaaaaaa.txt' };
  event.call.assets = [{ id: 'abcdefab.png', mimeType: 'image/png', bytes: 99000 }];
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/png;base64,YQ==' }));
  (w as any).api.getSessionImage = getImage;
  await app.append([event]);
  const tool = w.document.querySelector('details.tool') as HTMLDetailsElement;
  expect(getImage).not.toHaveBeenCalled();
  expect(tool.textContent).not.toContain('AAAA');
  expect(tool.textContent).not.toContain('aaaaaaaa.txt');
  tool.open = true; tool.dispatchEvent(new w.Event('toggle'));
  await settle();
  expect(tool.textContent).toContain('aaaaaaaa.txt');
  expect(tool.textContent).not.toContain('AAAA');
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdefab.png');
  expect(tool.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YQ==');
});

it('pages project tasks as complete parent/worker groups and keeps the selected task visible after reordering', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 8 }, (_, index) => ({ ...summary([]), id: `project-task-${index}`, conversationId: `chat-${index}`, title: `Task ${index}`, projectId: project.id }));
  const worker = { ...summary([]), id: 'project-worker', conversationId: 'worker-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: tasks[0]!.id, agentId: 'worker-1', task: 'Inspect' } };
  const entries = [...tasks, worker];
  const { w, append } = await boot([], true, [], [project], { sessions: entries });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  (section().querySelector('.worker-toggle') as HTMLButtonElement).click();
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  expect(section().querySelector('.worker-group [data-id="project-worker"]')).not.toBeNull();
  // A refresh can move the selected older task below the default five. Keep its complete group visible without expanding every other old task or splitting off its child.
  entries.splice(0, entries.length, ...tasks.slice(1), tasks[0]!, worker);
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(6);
  expect(section().querySelector('[data-id="project-task-0"]')).not.toBeNull();
  expect(section().querySelector('.worker-group [data-id="project-worker"]')).not.toBeNull();
  (section().querySelector('.project-show-more') as HTMLButtonElement).click();
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
});

it('shows five project chats initially and reveals eight more per click', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 22 }, (_, index) => ({ ...summary([]), id: `page-task-${index}`, conversationId: `chat-${index}`, projectId: project.id }));
  const { w, append } = await boot([], false, [], [project], { sessions: tasks });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  for (const count of [13, 21, 22]) {
    (section().querySelector('.project-show-more') as HTMLButtonElement).click();
    expect(section().querySelectorAll(':scope > .sess')).toHaveLength(count);
  }
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(22);
});

it('shows original user text while retaining transport instructions outside the visible bubble', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-one', inputId: 'one', authoredText: 'hello', message: text('hello\n\nTransport-only control instruction') }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('hello');
  expect(w.document.body.textContent).toContain('hello');
});

it.each(['', '\n', '\n\n'])('hides complete worker instructions without an app receipt, including native prefix %j', async prefix => {
  const sent = prefix + prependUserPrompt('Visible authored message', 'Invisible complete guidance');
  const { w } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'echo', message: text(sent) }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('Visible authored message');
  expect(w.document.body.textContent).not.toContain('Invisible complete guidance');
});

it('imports one physical file drop from the composer, timeline, or sidebar exactly once and caps attachments', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const image = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'dropped.md', size: 12, mimeType: 'text/markdown' };
  api.dropFiles = vi.fn(async () => ({ ok: true, data: [image] }));
  const drop = (target: Element, count: number) => {
    const event = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: Array.from({ length: count }, () => new w.File(['image'], 'image.png', { type: 'image/png' })) } });
    target.dispatchEvent(event);
    return event;
  };
  expect(drop(w.document.getElementById('timeline')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(1);
  expect(drop(w.document.getElementById('composer')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(2);
  expect(drop(w.document.getElementById('sessionList')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(3);
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(3);
  expect(w.document.getElementById('composerImages')!.textContent).toContain('dropped.md');
  drop(w.document.getElementById('composer')!, 48);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(3);
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(3);
});
