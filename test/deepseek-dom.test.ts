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
  continueButton(): FakeNode | null;
  thinkStopped(): boolean;
  pageError(): boolean;
  generating(): boolean;
  lastAnswer(): string;
  lastThink(): string;
  setValue(textarea: FakeNode, text: string): void;
  signedIn(): boolean;
  newChat(): FakeNode | null;
  hasConversation(): boolean;
  isNewChatRoute(): boolean;
  isFreshConversation(): boolean;
  newChatVisible(): boolean;
  activateNewChat(control: FakeNode | null): boolean;
  inspect(): Record<string, unknown> | null;
}

interface FakeNode {
  id?: string;
  name?: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  textContent: string;
  innerText: string;
  parent: FakeNode | null;
  readonly parentElement: FakeNode | null;
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
    disabled: false,
    value: '',
    textContent: attrs.text ?? '',
    innerText: attrs.text ?? '',
    parent: null,
    get parentElement() { return this.parent; },
    children,
    events: [],
    d: attrs.d,
    key: attrs.key,
    getAttribute(name) {
      if (name === 'd') return this.d ?? null;
      if (name === 'id') return this.id ?? null;
      if (name === 'class') return this.className || null;
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
  Object.defineProperty(created, 'classList', {
    get() { return this.className.split(/\s+/).filter(Boolean); }
  });
  Object.defineProperty(created, 'parentElement', {
    get() { return this.parent; }
  });
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
  if (/^\[(?:aria-label|title|data-testid|data-tooltip-content|data-tooltip)\]$/.test(selector)) {
    return Boolean(candidate.getAttribute(selector.slice(1, -1)));
  }
  if (selector === '[class*="new"]') return candidate.className.toLowerCase().includes('new');
  if (selector === '[id*="new"]') return String(candidate.id || '').toLowerCase().includes('new');
  if (selector === '[class*="conversation"]') return candidate.className.toLowerCase().includes('conversation');
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
class FakePointerEvent {
  constructor(readonly type: string) {}
}
const nativeValues = new WeakMap<object, string>();
Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
  get() { return nativeValues.get(this) ?? ''; },
  set(value: string) { nativeValues.set(this, String(value)); }
});

function load(body: FakeNode[], options: { composer?: boolean; sendRole?: boolean; title?: string } = {}): {
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
    title: options.title ?? '',
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
    window: { HTMLTextAreaElement, Event, PointerEvent: FakePointerEvent },
    PointerEvent: FakePointerEvent,
    Event,
    Date,
    URL,
    location: {
      href: 'https://chat.deepseek.com/',
      assigned: [] as string[],
      assign(url: string) { (this.assigned as string[]).push(url); this.href = url; }
    },
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

it('prefers a new in-thread greeting over leftover recap still in the visible list', () => {
  const leftover = node('div', {
    class: 'ds-assistant-message-main-content ds-markdown',
    text: 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.'
  });
  const list = node('div', { class: 'ds-virtual-list-visible-items' }, [leftover]);
  const greeting = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  const { api } = load([list, greeting]);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
});

it('still sees leftover markdown outside an empty visible thread list so complete can absorb it', () => {
  const leftover = node('div', {
    class: 'ds-assistant-message-main-content ds-markdown',
    text: 'Sí, ya quedó implementado el descuento dinámico por producto. core.js'
  });
  const list = node('div', { class: 'ds-virtual-list-visible-items' });
  const { api } = load([leftover, list]);
  expect(api.lastAnswer()).toBe('Sí, ya quedó implementado el descuento dinámico por producto. core.js');
});

it('reads a greeting painted outside an empty visible thread list', () => {
  const list = node('div', { class: 'ds-virtual-list-visible-items' });
  const greeting = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  const { api } = load([list, greeting]);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
});

it('reads the chat thread when a hashed sidebar virtual list comes first', () => {
  const history = node('div', { class: 'ds-virtual-list-visible-items' }, [
    node('div', { text: 'Librería Brújula' }),
    node('div', { text: 'HOLA' })
  ]);
  const sidebar = node('div', { class: 'c7e7ac15' }, [history]);
  const greeting = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  const thread = node('div', { class: 'ds-virtual-list-visible-items' }, [greeting]);
  const { api } = load([sidebar, thread]);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
  expect(api.hasConversation()).toBe(true);
});

it('skips hidden and sidebar leftover, and still reads stray markdown so complete can absorb it', () => {
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. core.js';
  const hidden = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
  hidden.hidden = true;
  const preview = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
  const sidebar = node('aside', { class: 'sidebar' }, [preview]);
  const stray = node('div', { class: 'ds-markdown', text: leftover });
  const { api } = load([hidden, sidebar, stray]);
  expect(api.lastAnswer()).toBe(leftover);
});

it('reads a public answer even when the node has empty client rects (virtualized offscreen)', () => {
  const answer = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  answer.getClientRects = () => [];
  const { api } = load([answer]);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
});

it('reads the chat thread lastAnswer when the sidebar also has a virtual list', () => {
  const history = node('div', { class: 'ds-virtual-list-visible-items' }, [
    node('a', { href: 'https://chat.deepseek.com/a/chat/s/abc', text: 'Librería Brújula' })
  ]);
  const sidebar = node('aside', { class: 'sidebar' }, [history]);
  const greeting = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  const thread = node('div', { class: 'ds-virtual-list-visible-items' }, [greeting]);
  const { api } = load([sidebar, thread]);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
  expect(api.hasConversation()).toBe(true);
});

it('does not treat the latest user bubble as lastAnswer while DeepSeek is still reasoning', () => {
  const user = node('div', { class: 'ds-message', text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHOLA' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'The user said hello. I should greet them in Spanish.' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
  const assistant = node('div', { class: 'ds-message' }, [think]);
  const { api } = load([user, assistant]);
  expect(api.lastAnswer()).toBe('');
  expect(api.lastThink()).toContain('The user said hello');
});

it('does not treat a user bubble that now contains ds-markdown as lastAnswer', () => {
  const packed = 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHOLA';
  const userMd = node('div', { class: 'ds-markdown', text: packed });
  const user = node('div', { class: 'ds-message' }, [userMd]);
  user.innerText = packed;
  user.textContent = packed;
  const thinkMd = node('div', { class: 'ds-markdown', text: 'El usuario saludó. Debo responder en español.' });
  const think = node('div', { class: '_4d41763' }, [thinkMd]);
  const assistant = node('div', { class: 'ds-message' }, [think]);
  const { api } = load([user, assistant]);
  expect(api.lastAnswer()).toBe('');
  expect(api.lastThink()).toContain('El usuario saludó');
});

it('reads the public greeting after a hashed think block and a markdown user bubble', () => {
  const packed = 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHOLA';
  const userMd = node('div', { class: 'ds-markdown fbb737a4', text: packed });
  const user = node('div', { class: 'ds-message' }, [userMd]);
  const thinkMd = node('div', { class: 'ds-markdown', text: 'Need to greet the user in Spanish.' });
  const think = node('div', { class: '_4d41763' }, [thinkMd]);
  const pub = node('div', { class: 'ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  const main = node('div', { class: 'ds-assistant-message-main-content' }, [think, pub]);
  const assistant = node('div', { class: 'ds-message' }, [main]);
  const { api } = load([user, assistant]);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
});

it('does not stay generating because an older assistant still has a leftover cursor', () => {
  const old = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'respuesta anterior' }, [
    node('div', { class: 'ds-cursor' })
  ]);
  const latest = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  const { api, send } = load([old, latest]);
  send.hidden = true;
  expect(api.generating()).toBe(false);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
});

it('reads the public greeting beside an open Razonando think panel', () => {
  const thinkMd = node('div', { class: 'ds-markdown', text: 'Need to greet the user in Spanish.' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
  const pub = node('div', { class: 'ds-markdown', text: 'Hola. ¿En qué te ayudo?' });
  const main = node('div', { class: 'ds-assistant-message-main-content' }, [think, pub]);
  const { api } = load([main]);
  expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
  expect(api.lastThink()).toContain('Need to greet the user');
});

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
  expect(status).toEqual({ signedIn: true, generating: false, freshConversation: true, hasConversation: false, newChatRoute: false, conversationId: null, canContinue: false });
  const { listeners: signedOut, api } = load([], { composer: false });
  expect(api.signedIn()).toBe(false);
  signedOut[0]!({ type: 'neuraflok-deepseek-status' }, {}, (value) => { status = value; });
  expect(status).toEqual({ signedIn: false, generating: false, freshConversation: true, hasConversation: false, newChatRoute: false, conversationId: null, canContinue: false });
});

it('does not call a DeepSeek new-chat route fresh while the previous thread is visible', () => {
  const previous = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Respuesta anterior.' });
  const { api, context } = load([previous]);
  (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
  expect(api.isNewChatRoute()).toBe(true);
  expect(api.hasConversation()).toBe(true);
  expect(api.isFreshConversation()).toBe(false);
});

it('keeps DeepSeek inspection diagnostics free of conversation text', () => {
  const privateText = 'NF16_PRIVATE_CONVERSATION_SENTINEL';
  const answer = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: privateText });
  const { api } = load([answer]);
  const inspect = api.inspect();
  expect(inspect).toMatchObject({ hasConversation: true, freshConversation: false, newChatAvailable: false });
  expect(JSON.stringify(inspect)).not.toContain(privateText);
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

it('treats Send on the page as idle over a leftover streaming cursor', () => {
  const cursor = node('div', { class: 'ds-cursor' });
  const { api, send } = load([cursor]);
  expect(api.sendButton()).toBe(send);
  expect(api.generating()).toBe(false);
});

it('complete skips a user markdown echo of the sent prompt', async () => {
  const echo = node('div', { class: 'ds-markdown', text: 'hello from NEURAFLOK' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { listeners, send } = load([echo, assistant]);
  send.click = function click() {
    this.events.push('click');
    setTimeout(() => {
      assistant.textContent = 'reply from DeepSeek';
      assistant.innerText = 'reply from DeepSeek';
    }, 1_000);
  };
  let reply: unknown;
  const kept = listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000001', conversationId: SESSION_ID, text: 'hello from NEURAFLOK' }, {}, (value) => { reply = value; });
  expect(kept).toBe(true);
  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'reply from DeepSeek' }), { timeout: 8_000 });
});

it('reports a missing send control separately from signed-out', async () => {
  const { listeners, send } = load([]);
  send.hidden = true;
  let reply: unknown;
  const kept = listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000002', conversationId: SESSION_ID, text: 'hi' }, {}, (value) => { reply = value; });
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
    listeners[0]!({ type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000003', conversationId: SESSION_ID, text: 'read a.txt' }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reply).toEqual({
      pending: true,
      text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}\n```',
      before: '',
      beforeThink: '',
      generating: true,
      canContinue: false
    });
  } finally {
    vi.useRealTimers();
  }
});

it('captures a leftover lastAnswer as before even while generating', async () => {
  vi.useFakeTimers();
  try {
    const prior = node('div', { class: '_9663006', text: 'old user' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const leftover = 'El proyecto Librería Brújula ya tiene el recap anterior.';
    const { listeners, send, stop, sessionStorage } = load([prior, assistant]);
    sessionStorage.setItem('neuraflok.providerSession', SESSION_ID);
    send.click = function click() {
      this.events.push('click');
      stop.hidden = false;
      send.hidden = true;
      assistant.innerText = leftover;
      assistant.textContent = leftover;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000014',
      conversationId: SESSION_ID,
      text: 'sigue con el recap'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reply).toMatchObject({
      pending: true,
      text: '',
      before: leftover,
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
      text: '',
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
  expect(reply).toMatchObject({
    signedIn: true, generating: false, conversationId: null, canContinue: false,
    text: '', answer: '', think: 'new think reply'
  });
});

it('does not treat the bootstrap ACK as a public follow-up after tools', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'Let me inspect command.js next.' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
  const { listeners } = load([ack, think]);
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-read',
    before: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/commander/lib/command.js"]}}\n```',
    beforeThink: ''
  }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({ answer: '' });
});

it('still reports the bootstrap ACK when nothing has been said yet', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const { listeners } = load([ack]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: '', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({ answer: 'NEURAFLOK_READY' });
});

it('does not treat English planning sentences as a public follow-up answer', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const plan = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'We need inspect project to identify complex files. Must not edit. Let\'s list files.' });
  const { listeners, send, stop } = load([ack, plan]);
  send.hidden = true;
  stop.hidden = false;
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'NEURAFLOK_READY', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({ answer: '', generating: true });
});

it('does not treat Spanish planning sentences as a public follow-up answer', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const plan = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Voy a listar los archivos del proyecto.' });
  const { listeners, send, stop } = load([ack, plan]);
  send.hidden = true;
  stop.hidden = false;
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'NEURAFLOK_READY', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({ answer: '', generating: true });
});

it('keeps a planning sentence that already contains a tool fence', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const plan = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Let me inspect the project.\n```neuraflok-tool\n{"name":"read","arguments":{"paths":["/commander"]}}\n```' });
  const { listeners } = load([ack, plan]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'NEURAFLOK_READY', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({
    answer: expect.stringContaining('```neuraflok-tool')
  });
});

it('does not report a Detenido think wrapper as the public follow-up answer', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'Let me explore the project structure first.' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
  const wrapper = node('div', { class: 'ds-message' }, [think]);
  wrapper.innerText = 'Detenido Let me explore the project structure first.';
  wrapper.textContent = wrapper.innerText;
  const { listeners } = load([ack, wrapper]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'NEURAFLOK_READY', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({
    answer: '',
    think: 'Let me explore the project structure first.'
  });
});

it('exposes the public assistant answer separately from think on read', () => {
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Este proyecto es Commander.js.' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'The user asked for a summary.' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
  const { listeners } = load([assistant, think]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: '', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({
    signedIn: true, generating: false, conversationId: null, canContinue: false,
    text: 'Este proyecto es Commander.js.',
    answer: 'Este proyecto es Commander.js.',
    think: 'The user asked for a summary.'
  });
});

it('does not treat the DeepSeek home logo as New chat', () => {
  const logo = node('a', { href: 'https://chat.deepseek.com/', text: 'DeepSeek' });
  const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
  const leftover = node('div', {
    class: 'ds-assistant-message-main-content ds-markdown',
    text: 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.'
  });
  const { api } = load([logo, leftover, starter]);
  expect(api.newChat()).toBe(starter);
  expect(api.newChat()).not.toBe(logo);
});

it('does not treat a homepage link without a New chat label as New chat', () => {
  const logo = node('a', { href: 'https://chat.deepseek.com/' });
  const leftover = node('div', {
    class: 'ds-assistant-message-main-content ds-markdown',
    text: 'Sí, ya quedó implementado el descuento dinámico por producto. core.js'
  });
  const { api } = load([logo, leftover]);
  expect(api.newChat()).toBeNull();
});

it('finds the semantic New chat link when the provider tab hides it from layout', () => {
  const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
  starter.hidden = true;
  const { api } = load([starter]);
  expect(api.newChat()).toBe(starter);
  expect(api.newChatVisible()).toBe(false);
});

it('finds the localized New conversation control by its accessible title', () => {
  const starter = node('button', { title: 'Nueva conversación' });
  starter.hidden = true;
  const { api } = load([starter]);
  expect(api.newChat()).toBe(starter);
  expect(api.newChatVisible()).toBe(false);
});

it('finds a provider New chat control by its test id when the icon has no text', () => {
  const starter = node('button', { 'data-testid': 'sidebar-new-chat-button' });
  const { api } = load([starter]);
  expect(api.newChat()).toBe(starter);
});

it('finds a New chat control when only its CSS class identifies it', () => {
  const starter = node('div', { class: 'ds-new-chat-button' });
  const { api } = load([starter]);
  expect(api.newChat()).toBe(starter);
});

it('finds DeepSeek New chat when it is rendered as plain clickable text', () => {
  const starter = node('div', { text: 'Nuevo chat' });
  const { api } = load([starter]);
  expect(api.newChat()).toBe(starter);
  expect(api.newChatVisible()).toBe(true);
});

it('clicks the React-owned parent of DeepSeek plain New chat text', () => {
  const label = node('span', { text: 'Nuevo chat' });
  const control = node('div', { text: 'Nuevo chat Ctrl + J' }, [label]);
  (control as unknown as Record<string, unknown>)['__reactProps$deepseek'] = { onClick: () => undefined };
  const { api } = load([control]);
  expect(api.newChat()).toBe(control);
});

it('activates DeepSeek New chat controls that only listen for React pointerdown', () => {
  const label = node('span', { text: 'Nuevo chat' });
  const control = node('div', { text: 'Nuevo chat Ctrl + J' }, [label]);
  (control as unknown as Record<string, unknown>)['__reactProps$deepseek'] = { onPointerDown: () => undefined };
  const { api } = load([control]);

  expect(api.newChat()).toBe(control);
  expect(api.activateNewChat(control)).toBe(true);
  expect(control.events).toEqual(['pointerdown', 'pointerup']);
});

it('acknowledges a new-chat command before activating a control that may navigate away', () => {
  vi.useFakeTimers();
  try {
    const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'Nuevo chat' });
    const { listeners, context } = load([starter]);
    starter.click = function click() {
      this.events.push('click');
      (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
    };
    let reply: unknown;
    listeners[0]!({ type: 'neuraflok-deepseek-open-new-chat' }, {}, value => { reply = value; });

    expect(reply).toEqual({ started: true });
    expect(starter.events).not.toContain('click');
    vi.advanceTimersByTime(0);
    expect(starter.events).toContain('click');
  } finally {
    vi.useRealTimers();
  }
});

it('does not treat a message that mentions a new chat as the New chat control', () => {
  const message = node('div', { text: 'I will start a new chat after finishing this task.' });
  const { api } = load([message]);
  expect(api.newChat()).toBeNull();
});

it('does not click a sidebar conversation titled Nuevo chat instead of the New chat control', () => {
  const starter = node('div', { text: 'Nuevo chat' });
  const history = node('a', { href: '/a/chat/s/old-thread', text: 'Nuevo chat' });
  const historyList = node('div', { class: 'history-list' }, [history]);
  const sidebar = node('aside', { class: 'sidebar' }, [historyList, starter]);
  const { api } = load([sidebar]);
  expect(api.newChat()).toBe(starter);
  expect(api.activateNewChat(history)).toBe(false);
  expect(history.events).not.toContain('click');
});

it('finds the app-root New chat anchor even inside the sidebar history container', () => {
  const starter = node('a', { href: '/', text: 'Nuevo chat' });
  const historyList = node('div', { class: 'history-list' }, [starter]);
  const { api } = load([historyList]);
  expect(api.newChat()).toBe(starter);
  expect(api.activateNewChat(starter)).toBe(true);
  expect(api.isNewChatRoute()).toBe(true);
  expect(api.inspect()).toMatchObject({
    pathKind: 'home', newChatKind: 'anchor-home', newChatActivated: true, newChatRoute: true
  });
});

it('accepts the new thread route DeepSeek opens after New chat', () => {
  const starter = node('button', { text: 'Nuevo chat' });
  const { api, context } = load([starter]);
  (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/old-thread';
  expect(api.isNewChatRoute()).toBe(false);
  expect(api.activateNewChat(starter)).toBe(true);
  expect(api.isNewChatRoute()).toBe(false);
  (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/5f0c2a18-7d4e-4a51-9a0b-3c6d8e2f1b47';
  expect(api.isNewChatRoute()).toBe(true);
  expect(api.inspect()).toMatchObject({
    pathKind: 'thread', newChatFromKind: 'thread', newChatKind: 'button', newChatActivated: true, newChatRoute: true
  });
});

it('accepts New chat that clears the current thread without changing the route', () => {
  const starter = node('button', { text: 'Nuevo chat' });
  const previous = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Respuesta anterior.' });
  const { api, context } = load([starter, previous]);
  (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/old-thread';
  expect(api.isNewChatRoute()).toBe(false);
  expect(api.activateNewChat(starter)).toBe(true);
  previous.textContent = '';
  previous.innerText = '';
  expect(api.isNewChatRoute()).toBe(true);
});

it('does not treat a history conversation titled Nuevo chat as New chat', () => {
  const history = node('a', { href: '/a/chat/s/old-thread', text: 'Nuevo chat' });
  const { api } = load([history]);
  expect(api.newChat()).toBeNull();
});

it('does not click a history conversation returned by an older New chat lookup', () => {
  const history = node('a', { href: 'https://chat.deepseek.com/a/chat/s/old-thread', text: 'Nuevo chat' });
  const { api } = load([history]);
  expect(api.activateNewChat(history)).toBe(false);
  expect(history.events).not.toContain('click');
});

it('sends the greeting when leftover recap stays painted after New chat', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const { listeners, send, context } = load([starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      // New chat clears the main thread (the leftover recap moves to history).
      assistant.innerText = '';
      assistant.textContent = '';
      (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
    };
    send.click = function click() {
      this.events.push('click');
      setTimeout(() => {
        assistant.innerText = 'pinglive42';
        assistant.textContent = 'pinglive42';
      }, 1_000);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000021',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nResponde solo con pinglive42.'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((context as { location: { assigned: string[] } }).location.assigned).toEqual([]);
    expect(starter.events).toContain('click');
    expect(send.events).toContain('click');
    expect(reply).toMatchObject({ text: 'pinglive42' });
  } finally {
    vi.useRealTimers();
  }
});

it('does not send a new-chat message while the provider page is still on the old conversation', async () => {
  vi.useFakeTimers();
  try {
    const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
    const previous = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Respuesta de ayer sobre el proyecto.' });
    const { listeners, send, context } = load([starter, previous]);
    starter.click = function click() { this.events.push('click'); };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000028',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(9_000);
    expect((context as { location: { href: string } }).location.href).toBe('https://chat.deepseek.com/');
    expect(reply).toMatchObject({ error: expect.stringMatching(/Could not open a new DEEPSEEK conversation/i) });
    expect(send.events).not.toContain('click');
  } finally {
    vi.useRealTimers();
  }
});

it('opens the new route through DeepSeek React pointerdown before sending the first message', async () => {
  vi.useFakeTimers();
  try {
    const label = node('span', { text: 'Nuevo chat' });
    const starter = node('div', { text: 'Nuevo chat Ctrl + J' }, [label]);
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, context } = load([starter, assistant]);
    (starter as unknown as Record<string, unknown>)['__reactProps$deepseek'] = {
      onPointerDown: () => {
        (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
      }
    };
    starter.dispatchEvent = function dispatchEvent(event) {
      this.events.push(event.type);
      if (event.type === 'pointerdown') {
        (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
      }
      return true;
    };
    send.click = function click() {
      this.events.push('click');
      assistant.innerText = 'OK-pointerdown';
      assistant.textContent = assistant.innerText;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000036',
      conversationId: SESSION_ID,
      text: 'Prueba de transición pointerdown',
      fresh: true
    }, {}, value => { reply = value; });

    await vi.advanceTimersByTimeAsync(9_000);
    expect(starter.events).toContain('pointerdown');
    expect(starter.events).not.toContain('click');
    expect(send.events).toContain('click');
    expect(reply).toMatchObject({ text: 'OK-pointerdown' });
  } finally {
    vi.useRealTimers();
  }
});

it('does not publish the leftover bookshop recap as the reply to Hola', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const logo = node('a', { href: 'https://chat.deepseek.com/', text: 'DeepSeek' });
    const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const { listeners, send } = load([logo, starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      assistant.innerText = '';
      assistant.textContent = '';
    };
    send.click = function click() {
      this.events.push('click');
      setTimeout(() => {
        assistant.innerText = 'Hola. Claro, dime el ejercicio de C++.';
        assistant.textContent = 'Hola. Claro, dime el ejercicio de C++.';
      }, 1_000);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000020',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHOLA PUEDES AYUDARME EN UNOS DEBERES DE C++'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(logo.events).not.toContain('click');
    expect(starter.events).toContain('click');
    expect(reply).toMatchObject({ text: 'Hola. Claro, dime el ejercicio de C++.' });
    expect(String((reply as { text?: string }).text || '')).not.toContain('descuento dinámico');
  } finally {
    vi.useRealTimers();
  }
});

it('does not treat sidebar history as a conversation on a blank home', async () => {
  vi.useFakeTimers();
  try {
  const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
  const sidebar = node('aside', { class: 'sidebar' }, [
    node('div', { class: 'ds-message', text: 'Solo zingprobe77' }),
    node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Sí, ya quedó implementado el descuento dinámico. core.js' })
  ]);
  const thread = node('div', { class: 'ds-virtual-list-visible-items' });
  const { listeners, send, api, context } = load([starter, sidebar, thread]);
  starter.click = function click() {
    this.events.push('click');
    (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
  };
  expect(api.hasConversation()).toBe(false);
  expect(api.lastAnswer()).toBe('');
  send.click = function click() {
    this.events.push('click');
    setTimeout(() => {
      thread.appendChild(node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'zingok91' }));
    }, 1_000);
  };
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete',
    id: '00000000-0000-4000-8000-000000000023',
    conversationId: SESSION_ID,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nResponde solo con la palabra zingok91.',
    fresh: true
  }, {}, (value) => { reply = value; });
  await vi.advanceTimersByTimeAsync(12_000);
  expect(reply).toMatchObject({ text: 'zingok91' });
  expect(starter.events).toContain('click');
  expect(send.events).toContain('click');
  } finally {
    vi.useRealTimers();
  }
});

it('completes a greeting painted outside an empty visible thread list', async () => {
  vi.useFakeTimers();
  try {
    const list = node('div', { class: 'ds-virtual-list-visible-items' });
    const greeting = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, api } = load([list, greeting]);
    send.click = function click() {
      this.events.push('click');
      greeting.innerText = 'Hola. ¿En qué te ayudo?';
      greeting.textContent = 'Hola. ¿En qué te ayudo?';
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000027',
      conversationId: SESSION_ID,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
    expect(reply).toMatchObject({ text: 'Hola. ¿En qué te ayudo?' });
    expect(send.events).toContain('click');
  } finally {
    vi.useRealTimers();
  }
});

it('completes a greeting when the sidebar virtual list comes first in the document', async () => {
  vi.useFakeTimers();
  try {
    const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
    const history = node('div', { class: 'ds-virtual-list-visible-items' }, [
      node('a', { href: 'https://chat.deepseek.com/a/chat/s/abc', text: 'Librería Brújula' })
    ]);
    const sidebar = node('aside', { class: 'sidebar' }, [history]);
    const thread = node('div', { class: 'ds-virtual-list-visible-items' });
    const { listeners, send, api, context } = load([starter, sidebar, thread]);
    expect(api.lastAnswer()).toBe('');
    starter.click = function click() {
      this.events.push('click');
      (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
    };
    send.click = function click() {
      this.events.push('click');
      thread.appendChild(node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Hola. ¿En qué te ayudo?' }));
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000025',
      conversationId: SESSION_ID,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
      fresh: true
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(api.lastAnswer()).toBe('Hola. ¿En qué te ayudo?');
    expect(reply).toMatchObject({ text: 'Hola. ¿En qué te ayudo?' });
    expect(send.events).toContain('click');
  } finally {
    vi.useRealTimers();
  }
});

it('completes a conversation-only greeting painted beside an open think panel', async () => {
  vi.useFakeTimers();
  try {
    const thinkMd = node('div', { class: 'ds-markdown', text: '' });
    const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
    const pub = node('div', { class: 'ds-markdown', text: '' });
    const main = node('div', { class: 'ds-assistant-message-main-content' }, [think, pub]);
    const { listeners, send } = load([main]);
    send.click = function click() {
      this.events.push('click');
      thinkMd.textContent = 'Need to greet the user in Spanish.';
      thinkMd.innerText = thinkMd.textContent;
      think.innerText = thinkMd.innerText;
      setTimeout(() => {
        pub.textContent = 'Hola. ¿En qué te ayudo?';
        pub.innerText = pub.textContent;
      }, 800);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000026',
      conversationId: SESSION_ID,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(reply).toMatchObject({ text: 'Hola. ¿En qué te ayudo?' });
  } finally {
    vi.useRealTimers();
  }
});

it('waits for a delayed previous thread to hydrate before sending into a fresh chat', async () => {
  vi.useFakeTimers();
  try {
  const leftover = 'El panel ya lista los productos y aplica el descuento dinámico.';
  const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { listeners, send, context } = load([starter, assistant]);
  setTimeout(() => {
    assistant.textContent = leftover;
    assistant.innerText = leftover;
  }, 5_000);
  starter.click = function click() {
    this.events.push('click');
    assistant.innerText = '';
    assistant.textContent = '';
    (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
  };
  send.click = function click() {
    this.events.push('click');
    setTimeout(() => {
      assistant.innerText = 'Listo, dime el siguiente cambio.';
      assistant.textContent = 'Listo, dime el siguiente cambio.';
    }, 1_000);
  };
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete',
    id: '00000000-0000-4000-8000-000000000024',
    conversationId: SESSION_ID,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, {}, (value) => { reply = value; });
  await vi.advanceTimersByTimeAsync(12_000);
  expect(reply).toMatchObject({ text: 'Listo, dime el siguiente cambio.' });
  expect(starter.events).toContain('click');
  expect(send.events).toContain('click');
  expect(String((reply as { text?: string }).text || '')).not.toContain('descuento dinámico');
  } finally {
    vi.useRealTimers();
  }
});

it('opens a new conversation from a blank DeepSeek home before sending', async () => {
  vi.useFakeTimers();
  try {
  const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { listeners, send, api, context } = load([starter, assistant]);
  expect(api.newChat()).toBe(starter);
  starter.click = function click() {
    this.events.push('click');
    (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
  };
  send.click = function click() {
    this.events.push('click');
    setTimeout(() => {
      assistant.textContent = 'zingprobe77';
      assistant.innerText = 'zingprobe77';
    }, 1_000);
  };
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete',
    id: '00000000-0000-4000-8000-000000000005',
    conversationId: SESSION_ID,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nResponde solo con la palabra zingprobe77.',
    fresh: true
  }, {}, (value) => { reply = value; });
  await vi.advanceTimersByTimeAsync(12_000);
  expect(reply).toMatchObject({ text: 'zingprobe77' });
  expect(starter.events).toContain('click');
  expect(send.events).toContain('click');
  } finally {
    vi.useRealTimers();
  }
});

it('sends a fresh chat even when leftover recap still shows Stop', async () => {
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
  const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
  const { listeners, send, stop, api } = load([starter, assistant]);
  send.hidden = true;
  stop.hidden = false;
  expect(api.generating()).toBe(true);
  starter.click = function click() {
    this.events.push('click');
    assistant.innerText = '';
    assistant.textContent = '';
    stop.hidden = true;
    send.hidden = false;
  };
  send.click = function click() {
    this.events.push('click');
    setTimeout(() => {
      assistant.textContent = 'Hola. ¿En qué te ayudo?';
      assistant.innerText = 'Hola. ¿En qué te ayudo?';
    }, 400);
  };
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete',
    id: '00000000-0000-4000-8000-000000000023',
    conversationId: SESSION_ID,
    fresh: true,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
  }, {}, (value) => { reply = value; });
  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'Hola. ¿En qué te ayudo?' }), { timeout: 8_000 });
  expect(starter.events).toContain('click');
  expect(send.events).toContain('click');
  expect(String((reply as { error?: string }).error || '')).not.toMatch(/still generating/i);
});

it('retries a fresh send that the page dropped while restoring its composer', async () => {
  vi.useFakeTimers();
  try {
    const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, context } = load([starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
    };
    let attempts = 0;
    send.click = function click() {
      this.events.push('click');
      attempts += 1;
      // First click is swallowed by the page re-render; the retry succeeds.
      if (attempts >= 2) {
        setTimeout(() => {
          assistant.textContent = 'OK-retry-send';
          assistant.innerText = assistant.textContent;
        }, 200);
      }
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000071',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nResponde solo OK-retry-send.'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toBe(2);
    expect(reply).toMatchObject({ text: 'OK-retry-send' });
  } finally {
    vi.useRealTimers();
  }
});

it('reports a send the page never accepts instead of watching an unsent turn', async () => {
  vi.useFakeTimers();
  try {
    const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, context } = load([starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000072',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send.events).toContain('click');
    expect(reply).toMatchObject({
      error: expect.stringMatching(/did not send this message/i)
    });
  } finally {
    vi.useRealTimers();
  }
});

it('does not complete a fresh chat with a leftover lastAnswer painted after send', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, context } = load([starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      (context as { location: { href: string } }).location.href = 'https://chat.deepseek.com/a/chat/s/new-conversation';
    };
    send.click = function click() {
      this.events.push('click');
      assistant.innerText = leftover;
      assistant.textContent = leftover;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000015',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'HOLA PUEDES AYUDARME EN ALGUNAS DDAS DE C++ QUE TENGO'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reply).toMatchObject({ before: leftover });
    expect((reply as { text?: string }).text || '').not.toBe(leftover);
  } finally {
    vi.useRealTimers();
  }
});

it('does not complete a fresh chat with a leftover lastAnswer painted late after send', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const { listeners, send } = load([starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      assistant.innerText = '';
      assistant.textContent = '';
    };
    send.click = function click() {
      this.events.push('click');
      setTimeout(() => {
        assistant.innerText = leftover;
        assistant.textContent = leftover;
      }, 2_500);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000016',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'HOLA'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reply).toMatchObject({ before: leftover });
    expect((reply as { text?: string }).text || '').not.toBe(leftover);
  } finally {
    vi.useRealTimers();
  }
});

it('does not return a leftover recap as the reply when the packed project prompt also looks like a recap', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const { listeners, send } = load([starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      assistant.innerText = '';
      assistant.textContent = '';
    };
    send.click = function click() {
      this.events.push('click');
      setTimeout(() => {
        assistant.innerText = leftover;
        assistant.textContent = leftover;
      }, 1_200);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000031',
      conversationId: SESSION_ID,
      fresh: true,
      text: `Project tree\ncore.js\n\nWhere we left off: ${leftover}\n\n## Current user request\nLee SPEC.md y sigue.`
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(50_000);
    expect((reply as { text?: string }).text || '').not.toContain('descuento dinámico');
    expect((reply as { error?: string }).error).toBeUndefined();
    expect(reply).toMatchObject({ pending: true, before: leftover });
  } finally {
    vi.useRealTimers();
  }
});

it('returns a new project greeting after leftover recap even when the packed prompt contains the recap', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/a/chat/s/new-conversation', text: 'New chat' });
    const leftoverNode = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const greeting = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send } = load([starter, leftoverNode, greeting]);
    starter.click = function click() {
      this.events.push('click');
      leftoverNode.innerText = '';
      leftoverNode.textContent = '';
    };
    send.click = function click() {
      this.events.push('click');
      leftoverNode.innerText = leftover;
      leftoverNode.textContent = leftover;
      setTimeout(() => {
        greeting.innerText = 'Listo. Ya leí SPEC.md y sigo con el descuento.';
        greeting.textContent = 'Listo. Ya leí SPEC.md y sigo con el descuento.';
      }, 1_500);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000032',
      conversationId: SESSION_ID,
      fresh: true,
      text: `Project tree\ncore.js\n\nWhere we left off: ${leftover}\n\n## Current user request\nLee SPEC.md y sigue.`
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(reply).toMatchObject({ text: 'Listo. Ya leí SPEC.md y sigo con el descuento.' });
    expect((reply as { error?: string }).error).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps a leftover project recap pending on a conversation-only greeting until a new reply paints', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const cont = node('span', { text: 'Continuar' });
    const { listeners, send } = load([starter, assistant, cont]);
    starter.click = function click() {
      this.events.push('click');
      assistant.innerText = '';
      assistant.textContent = '';
    };
    send.click = function click() {
      this.events.push('click');
      assistant.innerText = leftover;
      assistant.textContent = leftover;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000017',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(reply).toMatchObject({ pending: true, before: leftover });
    expect((reply as { text?: string }).text || '').not.toContain('descuento dinámico');
    expect((reply as { error?: string }).error).toBeUndefined();
    expect(cont.events).not.toContain('click');
  } finally {
    vi.useRealTimers();
  }
});

it('completes a conversation-only greeting in the first seconds when leftover recap stays in the visible list', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
    const leftoverNode = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const list = node('div', { class: 'ds-virtual-list-visible-items' });
    const greeting = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send } = load([starter, list, leftoverNode, greeting]);
    starter.click = function click() {
      this.events.push('click');
      leftoverNode.innerText = '';
      leftoverNode.textContent = '';
    };
    send.click = function click() {
      this.events.push('click');
      leftoverNode.innerText = leftover;
      leftoverNode.textContent = leftover;
      list.appendChild(leftoverNode);
      setTimeout(() => {
        greeting.innerText = 'Hola. ¿En qué te ayudo?';
        greeting.textContent = 'Hola. ¿En qué te ayudo?';
      }, 1_000);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000019',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reply).toMatchObject({ text: 'Hola. ¿En qué te ayudo?' });
    expect((reply as { error?: string }).error).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('completes a conversation-only greeting after leftover recap when a new reply paints', async () => {
  vi.useFakeTimers();
  try {
    const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
    const starter = node('a', { href: 'https://chat.deepseek.com/', text: 'New chat' });
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
    const { listeners, send } = load([starter, assistant]);
    starter.click = function click() {
      this.events.push('click');
      assistant.innerText = '';
      assistant.textContent = '';
    };
    send.click = function click() {
      this.events.push('click');
      assistant.innerText = leftover;
      assistant.textContent = leftover;
      setTimeout(() => {
        assistant.innerText = 'Hola. ¿En qué te ayudo?';
        assistant.textContent = 'Hola. ¿En qué te ayudo?';
      }, 8_000);
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000018',
      conversationId: SESSION_ID,
      fresh: true,
      text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
    }, {}, (value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reply).toMatchObject({ text: 'Hola. ¿En qué te ayudo?' });
    expect((reply as { error?: string }).error).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('never binds a new local session to an existing DeepSeek conversation without a new-chat control', async () => {
  vi.useFakeTimers();
  try {
  const oldConversation = node('div', { class: 'ds-message', text: 'Existing conversation' });
  const { listeners, sessionStorage, send } = load([oldConversation]);
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000006',
    conversationId: SESSION_ID, text: 'do not send into the previous chat', fresh: true
  }, {}, value => { reply = value; });
  await vi.advanceTimersByTimeAsync(8_500);
  expect(reply).toMatchObject({ error: expect.stringMatching(/new-chat control/i) });
  expect(send.events).not.toContain('click');
  expect(sessionStorage.getItem('neuraflok.providerSession')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('reads the bootstrap ACK from the chat title when the virtual list has not painted', () => {
  const header = node('div', { class: 'the-header', text: 'NEURAFLOK_READY' });
  const { api } = load([header], { title: 'NEURAFLOK_READY - DeepSeek' });
  expect(api.lastAnswer()).toBe('NEURAFLOK_READY');
});

it('prefers painted assistant markdown over the chat title', () => {
  const header = node('div', { class: 'the-header', text: 'NEURAFLOK_READY' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Voy a listar los archivos.' });
  const { api } = load([header, assistant], { title: 'NEURAFLOK_READY - DeepSeek' });
  expect(api.lastAnswer()).toBe('Voy a listar los archivos.');
});

it('does not treat a think-only wrapper message as the public answer', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'Let me explore the project structure first.' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
  const wrapper = node('div', { class: 'ds-message' }, [think]);
  wrapper.innerText = 'Detenido Let me explore the project structure first.';
  wrapper.textContent = wrapper.innerText;
  const { api } = load([ack, wrapper]);
  expect(api.lastAnswer()).toBe('NEURAFLOK_READY');
  expect(api.lastThink()).toBe('Let me explore the project structure first.');
});

it('keeps a follow-up pending when only think has appeared after the bootstrap ACK', async () => {
  vi.useFakeTimers();
  try {
    const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
    const thinkMd = node('div', { class: 'ds-markdown', text: '' });
    const think = node('div', { class: 'ds-think-content' }, [thinkMd]);
    const wrapper = node('div', { class: 'ds-message' }, [think]);
    const { listeners, send, sessionStorage, api } = load([ack, wrapper]);
    sessionStorage.setItem('neuraflok.providerSession', SESSION_ID);
    expect(api.lastAnswer()).toBe('NEURAFLOK_READY');
    send.click = function click() {
      this.events.push('click');
      thinkMd.textContent = 'Let me explore the project structure first.';
      thinkMd.innerText = thinkMd.textContent;
      think.innerText = thinkMd.innerText;
      wrapper.innerText = `Detenido ${thinkMd.innerText}`;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000009',
      conversationId: SESSION_ID,
      text: 'what files are hardest',
      before: 'NEURAFLOK_READY'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(reply).toMatchObject({ pending: true, before: 'NEURAFLOK_READY' });
    expect((reply as { text?: string }).text).not.toBe('NEURAFLOK_READY');
  } finally {
    vi.useRealTimers();
  }
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

it('does not treat a leftover think spinner as generating while Send is visible', () => {
  const spinner = node('div', { class: 'ds-loading' });
  const think = node('div', { class: 'ds-think-content' }, [spinner]);
  const { api, send } = load([think]);
  expect(api.sendButton()).toBe(send);
  expect(api.generating()).toBe(false);
});

it('does not treat a leftover think spinner as generating when Send is disabled', () => {
  const spinner = node('div', { class: 'ds-loading' });
  const think = node('div', { class: 'ds-think-content' }, [spinner]);
  const { api, send } = load([think]);
  send.disabled = true;
  send.className = 'ds-button ds-button--primary ds-button--circle ds-button--disabled';
  expect(api.sendButton()).toBeNull();
  expect(api.generating()).toBe(false);
});

it('treats Detenido think with Continuar as idle even if a spinner remains and Send is gone', () => {
  const spinner = node('div', { class: 'ds-loading' });
  const cont = node('span', { text: 'Continuar' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'Voy a listar los archivos del proyecto.' });
  const think = node('div', { class: 'ds-think-content' }, [spinner, thinkMd, cont]);
  const wrapper = node('div', { class: 'ds-message' }, [think]);
  wrapper.innerText = 'Detenido Voy a listar los archivos del proyecto. Continuar';
  wrapper.textContent = wrapper.innerText;
  const { api, send } = load([wrapper]);
  send.hidden = true;
  expect(api.thinkStopped()).toBe(true);
  expect(api.continueButton()).toBe(cont);
  expect(api.generating()).toBe(false);
});

it('treats leftover Stop with Continuar as idle so the watcher can click resume', () => {
  const cont = node('span', { text: 'Continuar' });
  const thinkMd = node('div', { class: 'ds-markdown', text: 'Voy a leer el proyecto.' });
  const think = node('div', { class: 'ds-think-content' }, [thinkMd, cont]);
  const wrapper = node('div', { class: 'ds-message' }, [think]);
  wrapper.innerText = 'Detenido Voy a leer el proyecto. Continuar';
  wrapper.textContent = wrapper.innerText;
  const { api, send, stop } = load([wrapper]);
  send.hidden = true;
  stop.hidden = false;
  expect(api.continueButton()).toBe(cont);
  expect(api.thinkStopped()).toBe(true);
  expect(api.generating()).toBe(false);
});

it('treats live Stop as generating even if leftover Continuar remains on an old recap', () => {
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
  const cont = node('span', { text: 'Continuar' });
  const markdown = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: leftover });
  const wrapper = node('div', { class: 'ds-message' }, [markdown, cont]);
  wrapper.innerText = leftover;
  wrapper.textContent = leftover;
  const { api, send, stop } = load([wrapper]);
  send.hidden = true;
  stop.hidden = false;
  expect(api.thinkStopped()).toBe(false);
  expect(api.continueButton()).toBe(cont);
  expect(api.stopButton()).toBe(stop);
  expect(api.generating()).toBe(true);
});

it('does not treat hashed think as lastAnswer while Stop is visible', () => {
  const thinkMd = node('div', { class: 'ds-markdown', text: 'We need answer Spanish and keep the greeting short.' });
  const think = node('div', { class: '_5255ff8' }, [thinkMd]);
  const { api, send, stop } = load([think]);
  send.hidden = true;
  stop.hidden = false;
  expect(api.lastThink()).toContain('We need');
  expect(api.lastAnswer()).toBe('');
  expect(api.generating()).toBe(true);
});

it('does not treat a leftover answer cursor as generating while Send is visible', () => {
  const cursor = node('div', { class: 'ds-cursor' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Voy a leer AGENTS.md y seguir con el arbol.' }, [cursor]);
  const { api, send } = load([assistant]);
  expect(api.sendButton()).toBe(send);
  expect(api.generating()).toBe(false);
  expect(api.lastAnswer()).toContain('Voy a leer AGENTS.md');
});

it('does not treat a sidebar Continuar control as Continue generating', () => {
  const sidebar = node('button', { text: 'Continuar sesión anterior' });
  const { api } = load([sidebar]);
  expect(api.continueButton()).toBeNull();
});

it('keeps a finished public answer that starts with planning words', () => {
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Let me explain how the binary tree insert works.' });
  const { listeners } = load([assistant]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'NEURAFLOK_READY', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({
    generating: false,
    answer: 'Let me explain how the binary tree insert works.',
    text: 'Let me explain how the binary tree insert works.'
  });
});

it('finds DeepSeek Continue generating and reports canContinue', () => {
  const cont = node('button', { text: 'Continue generating' });
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'partial answer' });
  const { api, listeners } = load([assistant, cont]);
  expect(api.continueButton()).toBe(cont);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: '', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({ canContinue: true, generating: false, answer: 'partial answer' });
});

it('clicks Continue generating instead of sending a new prompt', async () => {
  vi.useFakeTimers();
  try {
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const cont = node('button', { text: 'Continuar generando' });
    cont.hidden = true;
    const { listeners, send, api } = load([assistant, cont]);
    send.click = function click() {
      this.events.push('click');
      assistant.textContent = '```neuraflok-tool\n{"name":"read","arguments":{"paths":';
      assistant.innerText = assistant.textContent;
      cont.hidden = false;
    };
    cont.click = function click() {
      this.events.push('click');
      this.hidden = true;
      assistant.textContent = '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```';
      assistant.innerText = assistant.textContent;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000010',
      conversationId: SESSION_ID, text: 'read App.tsx'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(cont.events).toContain('click');
    expect(api.continueButton()).toBeNull();
    expect(reply).toMatchObject({
      text: expect.stringContaining('```neuraflok-tool')
    });
    expect(String((reply as { text?: string }).text)).toContain('/workspace/src/App.tsx');
  } finally {
    vi.useRealTimers();
  }
});

it('types a continue prompt when the tool fence is cut off and no Continue button exists', async () => {
  vi.useFakeTimers();
  try {
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, composer } = load([assistant]);
    let sends = 0;
    send.click = function click() {
      this.events.push('click');
      sends += 1;
      if (sends === 1) {
        assistant.textContent = '```neuraflok-tool\n{"name":"apply_patch","arguments":{"patch":';
        assistant.innerText = assistant.textContent;
        return;
      }
      assistant.textContent = '```neuraflok-tool\n{"name":"apply_patch","arguments":{"patch":"*** Begin Patch\\n*** Add File: /workspace/ui/Card.tsx\\n+export function Card() { return null }\\n*** End Patch"}}\n```';
      assistant.innerText = assistant.textContent;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000011',
      conversationId: SESSION_ID, text: 'add Card.tsx'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sends).toBeGreaterThan(1);
    expect(composer!.value).toContain('Continue exactly from where you stopped');
    expect(reply).toMatchObject({
      text: expect.stringContaining('Card.tsx')
    });
  } finally {
    vi.useRealTimers();
  }
});

it('resumes by clicking Continue when the page agent is asked to resume', async () => {
  const cont = node('button', { text: 'Continue generating' });
  const { listeners } = load([cont]);
  let reply: unknown;
  const kept = listeners[0]!({ type: 'neuraflok-deepseek-resume' }, {}, value => { reply = value; });
  expect(kept).toBe(true);
  await vi.waitFor(() => expect(reply).toEqual({ ok: true, mode: 'click' }));
  expect(cont.events).toContain('click');
});

it('does not treat an older server-unavailable bubble as a live page error', () => {
  const old = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'El servidor no está disponible temporalmente' });
  const latest = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'El arbol binario ya tiene insert y search.' });
  const { api, listeners } = load([old, latest]);
  expect(api.lastAnswer()).toBe('El arbol binario ya tiene insert y search.');
  expect(api.pageError()).toBe(false);
  let status: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-status' }, {}, (value) => { status = value; });
  expect(status).toMatchObject({ canContinue: false, generating: false });
});

it('does not treat a temporary server-unavailable banner as the assistant answer', () => {
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'El servidor no está disponible temporalmente' });
  const retry = node('button', { text: 'Reintentar' });
  const { api, listeners } = load([assistant, retry]);
  expect(api.lastAnswer()).toBe('');
  expect(api.pageError()).toBe(true);
  expect(api.continueButton()).toBe(retry);
  let status: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-status' }, {}, (value) => { status = value; });
  expect(status).toMatchObject({ canContinue: true, generating: false });
});

it('clicks Continuar when think is Detenido after a DeepSeek server stall', async () => {
  vi.useFakeTimers();
  try {
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const spinner = node('div', { class: 'ds-loading' });
    const thinkMd = node('div', { class: 'ds-markdown', text: '' });
    const cont = node('button', { text: 'Continuar' });
    cont.hidden = true;
    const think = node('div', { class: 'ds-think-content' }, [spinner, thinkMd, cont]);
    const wrapper = node('div', { class: 'ds-message' }, [think]);
    const { listeners, send, api } = load([assistant, wrapper]);
    send.click = function click() {
      this.events.push('click');
      this.hidden = true;
      thinkMd.textContent = 'Voy a leer el proyecto.';
      thinkMd.innerText = thinkMd.textContent;
      wrapper.innerText = 'Detenido Voy a leer el proyecto. Continuar';
      wrapper.textContent = wrapper.innerText;
      cont.hidden = false;
    };
    cont.click = function click() {
      this.events.push('click');
      this.hidden = true;
      send.hidden = false;
      spinner.hidden = true;
      assistant.textContent = '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```';
      assistant.innerText = assistant.textContent;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000013',
      conversationId: SESSION_ID, text: 'read App.tsx'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(cont.events).toContain('click');
    expect(api.continueButton()).toBeNull();
    expect(reply).toMatchObject({
      text: expect.stringContaining('/workspace/src/App.tsx')
    });
  } finally {
    vi.useRealTimers();
  }
});

it('clicks Reintentar when DeepSeek stops on a temporary server error', async () => {
  vi.useFakeTimers();
  try {
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const retry = node('button', { text: 'Reintentar' });
    retry.hidden = true;
    const { listeners, send, api } = load([assistant, retry]);
    send.click = function click() {
      this.events.push('click');
      assistant.textContent = 'El servidor no está disponible temporalmente';
      assistant.innerText = assistant.textContent;
      retry.hidden = false;
    };
    retry.click = function click() {
      this.events.push('click');
      this.hidden = true;
      assistant.textContent = '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```';
      assistant.innerText = assistant.textContent;
    };
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000012',
      conversationId: SESSION_ID, text: 'read App.tsx'
    }, {}, value => { reply = value; });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(retry.events).toContain('click');
    expect(api.continueButton()).toBeNull();
    expect(reply).toMatchObject({
      text: expect.stringContaining('/workspace/src/App.tsx')
    });
  } finally {
    vi.useRealTimers();
  }
});
