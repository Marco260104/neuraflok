import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import type { InputAttachment } from '../contracts/input.js';
import type { ChatEventRendererRuntime } from '../frontend/features/chat/chat-event-renderer.js';
import { createChatRendererAdapters } from '../frontend/features/chat/chat-renderer-adapters.js';

function attachmentRuntime(document: Document): ChatEventRendererRuntime {
  const element = (tag: string, className = '', text: string | (() => string) = ''): HTMLElement => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = typeof text === 'function' ? text() : text;
    return node;
  };
  return {
    $: (id: string) => document.getElementById(id) as HTMLElement,
    el: element,
    icon: (name: string) => element('i', `ico ${name}`),
    run: vi.fn(async () => null),
    setIcon: vi.fn(),
    toast: vi.fn(),
    t: (key: string) => key,
    ui: vi.fn(),
    api: {} as never,
    selectedLocalProject: () => null,
    openReview: vi.fn(async () => false),
    openWorkerChat: vi.fn(),
    sessions: [],
    selectedId: null,
    selectionGeneration: 0,
    events: [],
    startingInputs: new Map(),
    pendingComposerInputs: [],
    openTools: new Set()
  } as unknown as ChatEventRendererRuntime;
}

it('shows an animated spinner while uploading, then a file icon and visible uploaded confirmation', async () => {
  const dom = new JSDOM('<main></main>', { url: 'https://neuraflok.test/' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    const { createChatEventRenderer } = await import('../frontend/features/chat/chat-event-renderer.js');
    const renderer = createChatEventRenderer(attachmentRuntime(dom.window.document));
    const file: InputAttachment = { id: '00000000-0000-4000-8000-000000000031', name: 'synthetic.pdf', size: 15, mimeType: 'application/pdf' };
    const uploading = renderer.attachmentCard(file, true, 'uploading');
    expect(uploading.querySelector('.attachment-icon .attachment-loading-spinner')).not.toBeNull();
    expect(uploading.querySelector('.attachment-icon.is-loading')).not.toBeNull();
    expect(uploading.querySelector('.attachment-kind')?.textContent).toBe('Uploading…');
    expect(uploading.querySelector('.attachment-kind .attachment-loading-label')).not.toBeNull();
    expect(uploading.querySelector('.attachment-upload-status')).toBeNull();

    const sentWhileUploading = renderer.attachmentCard(file, false, 'uploading');
    expect(sentWhileUploading.querySelector('.attachment-icon .attachment-loading-spinner')).not.toBeNull();
    expect(sentWhileUploading.querySelector('.attachment-kind')?.textContent).toBe('Uploading…');
    expect(sentWhileUploading.querySelector('.attachment-kind .attachment-loading-label')).not.toBeNull();
    expect(sentWhileUploading.querySelector('.attachment-upload-status')).toBeNull();

    const ready = renderer.attachmentCard(file, true, 'ready');
    expect(ready.querySelector('.attachment-icon .i-file-text')).not.toBeNull();
    expect(ready.querySelector('.attachment-kind')?.textContent).toBe('File');
    expect(ready.querySelector('.attachment-upload-status.is-ready')?.textContent).toBe('Uploaded');

    const image: InputAttachment = { id: '00000000-0000-4000-8000-000000000033', name: 'synthetic.png', size: 15,
      mimeType: 'image/png', preview: 'data:image/png;base64,c3ludGhldGlj' };
    const readyImage = renderer.attachmentCard(image, true, 'ready');
    expect(readyImage.querySelector('.attachment-upload-status.is-ready')?.textContent).toBe('Uploaded');
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    dom.window.close();
  }
});

it('preserves the upload state when the composer routes attachment cards through the renderer adapter', () => {
  // Adapter forwarding is independent from the renderer implementation, which
  // reads the browser bridge at import time.
  const card = {} as HTMLElement;
  const attachmentCard = vi.fn(() => card);
  const renderer = { attachmentCard } as unknown as ReturnType<typeof import('../frontend/features/chat/chat-event-renderer.js').createChatEventRenderer>;
  const adapters = createChatRendererAdapters(() => renderer, () => ({} as never));
  const file: InputAttachment = { id: '00000000-0000-4000-8000-000000000032', name: 'synthetic.pdf', size: 15, mimeType: 'application/pdf' };

  expect(adapters.attachmentCard(file, true, 'uploading')).toBe(card);
  expect(attachmentCard).toHaveBeenCalledWith(file, true, 'uploading');
});
