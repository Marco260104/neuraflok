import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../browser-extension/src/provider-pages/deepseek/dom-adapter.js', import.meta.url), 'utf8');
const agentSource = readFileSync(new URL('../browser-extension/src/provider-pages/shared/delivery-agent.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../browser-extension/src/provider-pages/deepseek/controller.js', import.meta.url), 'utf8');
const SESSION_ID = 'ds-00000000-0000-0000-0000-000000000001';

interface DeepseekDomApi {
  composer(): FakeNode | null;
  sendButton(): FakeNode | null;
  stopButton(): FakeNode | null;
  generating(): boolean;
  lastAnswer(): string;
  lastThink(): string;
  setValue(textarea: FakeNode, text: string): void;
  signedIn(): boolean;
  newChat(): FakeNode | null;
  hasConversation(): boolean;
}

interface FakeNode {
  id?: string;
  name?: string;
  className: string;
  hidden: boolean;
  value: string;
  textContent: string;
  innerText: string;
  parent: FakeNode | null;
  children: FakeNode[];
  events: string[];
  d?: string;
  key?: string;
  tagName: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
  closest(selector: string): FakeNode | null;
  getClientRects(): Array<{ width: number; height: number }>;
  click(): void;
  dispatchEvent(event: { type: string }): boolean;
  addEventListener(type: string, fn: () => void): void;
  appendChild(child: FakeNode): FakeNode;
}

function node(tag: string, attrs: Record<string, string> = {}, children: FakeNode[] = []): FakeNode {
  const created: FakeNode = {
    tagName: tag.toUpperCase(),
    id: attrs.id,
    name: attrs.name,
    className: attrs.class ?? '',
    hidden: false,
    value: '',
    textContent: attrs.text ?? '',
    innerText: attrs.text ?? '',
    parent: null,
    children,
    events: [],
    d: attrs.d,
    key: attrs.key,
    getAttribute(name) {
      if (name === 'd') return this.d ?? null;
      if (name === 'id') return this.id ?? null;
      if (name === 'name') return this.name ?? null;
      if (name === 'data-virtual-list-item-key') return this.key ?? null;
      return attrs[name] ?? null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      return collect(this).filter(candidate => matches(candidate, selector));
    },
    closest(selector) {
      let current: FakeNode | null = this;
      while (current) {
        if (matches(current, selector)) return current;
        current = current.parent;
      }
      return null;
    },
    getClientRects() {
      return this.hidden ? [] : [{ width: 10, height: 10 }];
    },
    click() {
      this.events.push('click');
    },
    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    },
    addEventListener(type, fn) {
      const original = this.dispatchEvent.bind(this);
      this.dispatchEvent = (event) => {
        const ok = original(event);
        if (event.type === type) fn();
        return ok;
      };
    },
    appendChild(child: FakeNode) {
      this.children.push(child);
      child.parent = this;
      return child;
    }
  };
  for (const child of children) child.parent = created;
  return created;
}

function collect(root: FakeNode): FakeNode[] {
  return [root, ...root.children.flatMap(collect)];
}

function matches(candidate: FakeNode, selector: string): boolean {
  const parts = selector.split(',').map(part => part.trim());
  return parts.some(part => matchOne(candidate, part));
}

function hasClass(candidate: FakeNode, name: string): boolean {
  return candidate.className.split(/\s+/).includes(name);
}

function matchSimple(candidate: FakeNode, selector: string): boolean {
  if (selector === '[role="button"]') return candidate.getAttribute('role') === 'button';
  if (selector === 'textarea#chat-input') return candidate.tagName === 'TEXTAREA' && candidate.id === 'chat-input';
  if (selector === 'textarea[name="search"]') return candidate.tagName === 'TEXTAREA' && candidate.name === 'search';
  if (selector === '#chat-input') return candidate.id === 'chat-input';
  if (selector === 'a[href]') return candidate.tagName === 'A' && Boolean(candidate.getAttribute('href'));
  if (selector === '[data-virtual-list-item-key]') return Boolean(candidate.key);
  if (selector.startsWith('.')) return hasClass(candidate, selector.slice(1));
  if (/^[a-z][a-z0-9-]*$/i.test(selector)) return candidate.tagName === selector.toUpperCase();
  return false;
}

function matchOne(candidate: FakeNode, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed === '[data-virtual-list-item-key] .ds-markdown') {
    return hasClass(candidate, 'ds-markdown') && Boolean(candidate.closest('[data-virtual-list-item-key]'));
  }
  if (trimmed.includes(' ') && !trimmed.startsWith('[')) {
    const parts = trimmed.split(/\s+/);
    if (parts.length === 2) {
      return matchSimple(candidate, parts[1]!) && Boolean(candidate.closest(parts[0]!));
    }
  }
  return matchSimple(candidate, trimmed);
}

class HTMLTextAreaElement {}
const nativeValues = new WeakMap<object, string>();
Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
  get() { return nativeValues.get(this) ?? ''; },
  set(value: string) { nativeValues.set(this, String(value)); }
});

function load(body: FakeNode[], options: { composer?: boolean; sendRole?: boolean } = {}): {
  api: DeepseekDomApi;
  composer: FakeNode | null;
  send: FakeNode;
  attach: FakeNode;
  stop: FakeNode;
  document: { getElementById(id: string): FakeNode | null };
  sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown>;
  context: vm.Context;
} {
  const composer = options.composer === false ? null : node('textarea', { id: 'chat-input', name: 'search' });
  if (composer) {
    Object.setPrototypeOf(composer, HTMLTextAreaElement.prototype);
    Reflect.deleteProperty(composer, 'value');
  }
  const sendPath = node('path', { d: 'M8.3125 0.98abc' });
  const attachPath = node('path', { d: 'M5.5498 attach' });
  const stopPath = node('path', { d: 'M2 4.88stop' });
  const send = options.sendRole
    ? node('div', { role: 'button' }, [node('svg', {}, [sendPath])])
    : node('button', {}, [node('svg', {}, [sendPath])]);
  const attach = node('button', {}, [node('svg', {}, [attachPath])]);
  const stop = node('button', {}, [node('svg', {}, [stopPath])]);
  stop.hidden = true;
  const roots = [...(composer ? [composer] : []), send, attach, stop, ...body];
  const extras: FakeNode[] = [];
  const documentElement = node('html');
  const document = {
    querySelector(selector: string) {
      return roots.flatMap(collect).find(candidate => matches(candidate, selector)) ?? null;
    },
    querySelectorAll(selector: string) {
      return roots.flatMap(collect).filter(candidate => matches(candidate, selector));
    },
    getElementById(id: string) {
      return extras.find(candidate => candidate.id === id) ?? null;
    },
    createElement(tag: string) {
      const created = node(tag);
      extras.push(created);
      return created;
    },
    documentElement,
    body: node('body')
  };
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown> = [];
  const sessionRows = new Map<string, string>();
  const sessionStorage = {
    getItem(key: string) { return sessionRows.get(key) ?? null; },
    setItem(key: string, value: string) { sessionRows.set(key, value); },
    removeItem(key: string) { sessionRows.delete(key); }
  };
  const context = vm.createContext({
    document,
    window: { HTMLTextAreaElement, Event },
    Event,
    Date,
    URL,
    location: { href: 'https://chat.deepseek.com/' },
    sessionStorage,
    setTimeout,
    chrome: { runtime: { onMessage: { addListener(fn: (typeof listeners)[number]) { listeners.push(fn); } } } },
    globalThis: undefined as unknown
  });
  context.globalThis = context;
  vm.runInContext(domSource, context, { filename: 'deepseek-dom.js' });
  vm.runInContext(agentSource, context, { filename: 'delivery-agent.js' });
  vm.runInContext(contentSource, context, { filename: 'deepseek-content.js' });
  return {
    api: (context as unknown as { NEURAFLOK_DEEPSEEK: DeepseekDomApi }).NEURAFLOK_DEEPSEEK,
    composer,
    send,
    attach,
    stop,
    document,
    sessionStorage,
    listeners,
    context
  };
}

it('finds the composer, send, attach exclusion and last visible markdown answer', () => {
  const think = node('div', { class: 'ds-markdown', text: 'hidden thinking' });
  const thinkWrap = node('div', { class: 'ds-think-content' }, [think]);
  const visible = node('div', { class: 'ds-markdown', text: 'visible answer' });
  const item = node('div', { key: '1' }, [thinkWrap, visible]);
  const { api, composer, send } = load([item]);
  expect(api.composer()).toBe(composer);
  expect(api.signedIn()).toBe(true);
  expect(api.sendButton()).toBe(send);
  expect(api.stopButton()).toBeNull();
  expect(api.generating()).toBe(false);
  expect(api.lastAnswer()).toBe('visible answer');
});

it('sets the native textarea value and reports Stop while generating', () => {
  const { api, composer, send, stop } = load([]);
  const events: string[] = [];
  composer!.addEventListener('input', () => events.push('input'));
  api.setValue(composer!, 'please patch this file');
  expect(composer!.value).toBe('please patch this file');
  expect(events).toContain('input');
  stop.hidden = false;
  send.hidden = true;
  expect(api.stopButton()).toBe(stop);
  expect(api.generating()).toBe(true);
});

it('finds a role=button send control by its SVG path', () => {
  const { api, send } = load([], { sendRole: true });
  expect(api.sendButton()).toBe(send);
});

it('finds a ds-button primary circle when the SVG path is not the known send prefix', () => {
  const { api, send } = load([]);
  send.className = 'ds-button ds-button--primary ds-button--filled ds-button--circle';
  const path = send.querySelector('svg path');
  if (path) path.d = 'M10 2 other-arrow';
  expect(api.sendButton()).toBe(send);
});

it('treats a missing composer as signed out so the driver can ask for sign-in', () => {
  const { api } = load([], { composer: false });
  expect(api.composer()).toBeNull();
  expect(api.signedIn()).toBe(false);
});

it('answers neuraflok-deepseek-status and marks the page so the companion shows on DeepSeek', () => {
  const { listeners, document } = load([]);
  expect(listeners).toHaveLength(1);
  expect(document.getElementById('neuraflok-deepseek-badge')?.textContent).toBe('NEURAFLOK');
  let status: unknown;
  const kept = listeners[0]!({ type: 'neuraflok-deepseek-status' }, {}, (value) => { status = value; });
  expect(kept).toBeUndefined();
  expect(status).toEqual({ signedIn: true, generating: false, conversationId: null });
  const { listeners: signedOut, api } = load([], { composer: false });
  expect(api.signedIn()).toBe(false);
  signedOut[0]!({ type: 'neuraflok-deepseek-status' }, {}, (value) => { status = value; });
  expect(status).toEqual({ signedIn: false, generating: false, conversationId: null });
});

it('migrates a pending DeepSeek send claim into the NEURAFLOK page namespace', async () => {
  const { listeners, sessionStorage } = load([]);
  const requestId = '00000000-0000-4000-8000-000000000008';
  sessionStorage.setItem('neuraljam.providerSession', SESSION_ID);
  sessionStorage.setItem('neuraljam.sendClaim', requestId);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-complete', id: requestId, conversationId: SESSION_ID, text: 'retry' }, {}, value => { reply = value; });
  await vi.waitFor(() => expect(reply).toMatchObject({ pending: true }));
  expect(sessionStorage.getItem('neuraflok.providerSession')).toBe(SESSION_ID);
  expect(sessionStorage.getItem('neuraflok.sendClaim')).toBe(requestId);
  expect(sessionStorage.getItem('neuraljam.providerSession')).toBeNull();
  expect(sessionStorage.getItem('neuraljam.sendClaim')).toBeNull();
});

it('keeps one message listener when the isolated driver is injected twice', () => {
  const { listeners, context } = load([]);
  expect(listeners).toHaveLength(1);
  vm.runInContext(contentSource, context, { filename: 'deepseek-content.js' });
  expect(listeners).toHaveLength(1);
});

it('reads assistant markdown and skips a hashed user-bubble echo', () => {
  const user = node('div', { class: 'ds-markdown _9663006', text: '```neuraflok-tool\n{"name":"read","arguments":{"path":"/workspace/example.txt"}}\n```' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'I will read that file.' });
  const { api } = load([user, assistant]);
  expect(api.lastAnswer()).toBe('I will read that file.');
});

it('skips a hashed user bubble even when it is the only markdown', () => {
  const user = node('div', { class: 'ds-markdown _9663006', text: 'user prompt' });
  const { api } = load([user]);
  expect(api.lastAnswer()).toBe('');
});

it('does not treat a leftover Stop-like SVG as generating while Send is visible', () => {
  const decoy = node('button', {}, [node('svg', {}, [node('path', { d: 'M2 4.88 leftover-icon' })])]);
  const { api, send } = load([decoy]);
  expect(api.sendButton()).toBe(send);
  expect(api.generating()).toBe(false);
});

it('complete skips a user markdown echo of the sent prompt', async () => {
  const echo = node('div', { class: 'ds-markdown', text: 'hello from NEURAFLOK' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { listeners, send } = load([echo, assistant]);
  send.click = function click() {
    this.events.push('click');
    assistant.textContent = 'reply from DeepSeek';
    assistant.innerText = 'reply from DeepSeek';
  };
  let reply: unknown;
  const kept = listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000001', conversationId: SESSION_ID, fresh: true, text: 'hello from NEURAFLOK' }, {}, (value) => { reply = value; });
  expect(kept).toBe(true);
  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'reply from DeepSeek' }));
});

it('reports a missing send control separately from signed-out', async () => {
  const { listeners, send } = load([]);
  send.hidden = true;
  let reply: unknown;
  const kept = listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000002', conversationId: SESSION_ID, fresh: true, text: 'hi' }, {}, (value) => { reply = value; });
  expect(kept).toBe(true);
  await vi.waitFor(() => {
    expect(String((reply as { error?: string } | undefined)?.error || '')).toMatch(/send control was not found/i);
  }, { timeout: 8_000 });
});

it('rebuilds a DeepSeek code-block banner as a neuraflok-tool fence', () => {
  const banner = node('div', { class: 'md-code-block-banner', text: 'neuraflok-tool' });
  const code = node('pre', { text: '{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}' });
  const block = node('div', { class: 'md-code-block' }, [banner, code]);
  block.innerText = 'neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}';
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown' }, [block]);
  assistant.innerText = block.innerText;
  assistant.textContent = assistant.innerText;
  const { api } = load([assistant]);
  expect(api.lastAnswer()).toContain('```neuraflok-tool');
  expect(api.lastAnswer()).toContain('"name":"read"');
});

it('returns a pending grown lastAnswer when Stop stays up past the fast finish wait', async () => {
  vi.useFakeTimers();
  try {
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, stop } = load([assistant]);
    send.click = function click() {
      this.events.push('click');
      stop.hidden = false;
      send.hidden = true;
      assistant.innerText = '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}\n```';
      assistant.textContent = assistant.innerText;
    };
    let reply: unknown;
    listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000003', conversationId: SESSION_ID, fresh: true, text: 'read a.txt' }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reply).toEqual({
      pending: true,
      text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}\n```',
      before: '',
      beforeThink: '',
      generating: true
    });
  } finally {
    vi.useRealTimers();
  }
});

it('reads a new think panel when the previous public answer is still lastAnswer', async () => {
  vi.useFakeTimers();
  try {
    const previous = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'old public' });
    const thinkMd = node('div', { class: 'ds-markdown', text: '' });
    const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
    const { api, listeners, send, stop, sessionStorage } = load([previous, think]);
    sessionStorage.setItem('neuraflok.providerSession', SESSION_ID);
    expect(api.lastAnswer()).toBe('old public');
    expect(api.lastThink()).toBe('');
    send.click = function click() {
      this.events.push('click');
      stop.hidden = false;
      send.hidden = true;
      thinkMd.textContent = 'ArbolBinario.h and main.cpp';
      thinkMd.innerText = 'ArbolBinario.h and main.cpp';
      think.innerText = thinkMd.innerText;
    };
    let reply: unknown;
    listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000004', conversationId: SESSION_ID, text: 'write the tree' }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reply).toMatchObject({
      pending: true,
      text: 'ArbolBinario.h and main.cpp',
      before: 'old public',
      generating: true
    });
  } finally {
    vi.useRealTimers();
  }
});

it('answers neuraflok-deepseek-read with the grown think text', () => {
  const previous = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'old public' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'new think reply' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
  const { listeners } = load([previous, think]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'old public', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toEqual({ signedIn: true, generating: false, conversationId: null, text: 'new think reply' });
});

it('clicks New chat when the complete message asks for a fresh DeepSeek chat', async () => {
  const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { listeners, send, api } = load([starter, assistant]);
  expect(api.newChat()).toBe(starter);
  send.click = function click() {
    this.events.push('click');
    assistant.textContent = 'fresh reply';
    assistant.innerText = 'fresh reply';
  };
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000005', conversationId: SESSION_ID, text: 'hi', fresh: true }, {}, (value) => { reply = value; });
  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'fresh reply' }));
  expect(starter.events).toContain('click');
});

it('never binds a new local session to an existing DeepSeek conversation without a new-chat control', async () => {
  const oldConversation = node('div', { class: 'ds-message', text: 'Existing conversation' });
  const { listeners, sessionStorage, send } = load([oldConversation]);
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000006',
    conversationId: SESSION_ID, text: 'do not send into the previous chat', fresh: true
  }, {}, value => { reply = value; });
  await vi.waitFor(() => expect(reply).toMatchObject({ error: expect.stringMatching(/new-chat control/i) }));
  expect(send.events).not.toContain('click');
  expect(sessionStorage.getItem('neuraflok.providerSession')).toBeNull();
});

it('allows follow-up messages on the bound tab even if sessionStorage was blank', async () => {
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { listeners, send, sessionStorage } = load([assistant]);
  expect(sessionStorage.getItem('neuraflok.providerSession')).toBeNull();
  send.click = function click() {
    this.events.push('click');
    assistant.textContent = 'followup reply';
    assistant.innerText = 'followup reply';
  };
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000007',
    conversationId: SESSION_ID, text: 'followup query', fresh: false
  }, {}, value => { reply = value; });
  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'followup reply' }));
  expect(send.events).toContain('click');
  expect(sessionStorage.getItem('neuraflok.providerSession')).toBe(SESSION_ID);
});
