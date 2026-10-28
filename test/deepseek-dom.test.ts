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
  generating(): boolean;
  lastAnswer(): string;
  lastAnswerIdentity(): string;
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
  _valueTracker?: { setValue(value: string): void; getValue(): string };
  textContent: string;
  innerText: string;
  parent: FakeNode | null;
  children: FakeNode[];
  events: string[];
  d?: string;
  key?: string;
  tagName: string;
  shadowRoot?: FakeNode | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
  matches(selector: string): boolean;
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
    shadowRoot: null,
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
    matches(selector) {
      return matchOne(this, selector);
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
  if (selector === '*') return true;
  if (selector === '[role="button"]') return candidate.getAttribute('role') === 'button';
  if (selector === '[role="textbox"]') return candidate.getAttribute('role') === 'textbox';
  if (selector === '[contenteditable="true"]') return candidate.getAttribute('contenteditable') === 'true';
  if (selector === '[contenteditable]') return candidate.getAttribute('contenteditable') !== null;
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

function load(body: FakeNode[], options: { composer?: boolean; composerId?: boolean; composerPlaceholder?: string; hiddenSearch?: boolean | 'aria-hidden' | 'visible'; sendRole?: boolean; title?: string } = {}): {
  api: DeepseekDomApi;
  composer: FakeNode | null;
  send: FakeNode;
  attach: FakeNode;
  stop: FakeNode;
  document: { getElementById(id: string): FakeNode | null; body: FakeNode; visibilityState?: string; hidden?: boolean };
  sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown>;
  presenceObservers: Array<{ notify(): void }>;
  presenceMessages: Array<{ signedIn?: boolean }>;
  context: vm.Context;
} {
  const composer = options.composer === false ? null : node('textarea', {
    ...(options.composerId === false ? {} : { id: 'chat-input' }),
    ...(options.composerPlaceholder ? { placeholder: options.composerPlaceholder } : {}),
    name: 'search'
  });
  if (composer) {
    Object.setPrototypeOf(composer, HTMLTextAreaElement.prototype);
    Reflect.deleteProperty(composer, 'value');
  }
  const hiddenSearch = options.hiddenSearch ? node('textarea', {
    name: 'search',
    ...(options.hiddenSearch === 'aria-hidden' ? { 'aria-hidden': 'true' } : {})
  }) : null;
  if (hiddenSearch && options.hiddenSearch === true) hiddenSearch.hidden = true;
  const composerRoot = composer && options.composerId === false
    ? node('div', { class: 'ds-input' }, [composer])
    : composer;
  const sendPath = node('path', { d: 'M8.3125 0.98abc' });
  const attachPath = node('path', { d: 'M5.5498 attach' });
  const stopPath = node('path', { d: 'M2 4.88stop' });
  const send = options.sendRole
    ? node('div', { role: 'button' }, [node('svg', {}, [sendPath])])
    : node('button', {}, [node('svg', {}, [sendPath])]);
  const attach = node('button', {}, [node('svg', {}, [attachPath])]);
  const stop = node('button', {}, [node('svg', {}, [stopPath])]);
  stop.hidden = true;
  const documentBody = node('body');
  const roots = [...(hiddenSearch ? [hiddenSearch] : []), ...(composerRoot ? [composerRoot] : []), send, attach, stop, ...body];
  const extras: FakeNode[] = [];
  const documentElement = node('html');
  const document = {
    title: options.title ?? '',
    querySelector(selector: string) {
      return [...roots.flatMap(collect), ...collect(documentBody)].find(candidate => matches(candidate, selector)) ?? null;
    },
    querySelectorAll(selector: string) {
      return [...roots.flatMap(collect), ...collect(documentBody)].filter(candidate => matches(candidate, selector));
    },
    getElementById(id: string) {
      return extras.find(candidate => candidate.id === id) ?? null;
    },
    createElement(tag: string) {
      const created = node(tag);
      extras.push(created);
      return created;
    },
    addEventListener() {},
    documentElement,
    body: documentBody
  };
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown> = [];
  const presenceObservers: Array<{ notify(): void }> = [];
  const presenceMessages: Array<{ signedIn?: boolean }> = [];
  class FakeMutationObserver {
    constructor(private readonly callback: () => void) {}
    observe() { presenceObservers.push({ notify: () => this.callback() }); }
  }
  const sessionRows = new Map<string, string>();
  const sessionStorage = {
    getItem(key: string) { return sessionRows.get(key) ?? null; },
    setItem(key: string, value: string) { sessionRows.set(key, value); },
    removeItem(key: string) { sessionRows.delete(key); }
  };
  const context = vm.createContext({
    document,
    window: { HTMLTextAreaElement, Event, addEventListener() {} },
    Event,
    MutationObserver: FakeMutationObserver,
    addEventListener() {},
    Date,
    URL,
    location: { href: 'https://chat.deepseek.com/' },
    sessionStorage,
    setTimeout,
    chrome: { runtime: {
      onMessage: { addListener(fn: (typeof listeners)[number]) { listeners.push(fn); } },
      sendMessage(message: { signedIn?: boolean }) { presenceMessages.push(message); }
    } },
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
    presenceObservers,
    presenceMessages,
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

it('leaves React able to observe the native textarea value change', () => {
  const { api, composer } = load([]);
  let trackedValue = '';
  let observedValue = '';
  composer!._valueTracker = {
    setValue(value) { trackedValue = value; },
    getValue() { return trackedValue; }
  };
  composer!.addEventListener('input', () => {
    if (composer!.value !== composer!._valueTracker!.getValue()) {
      observedValue = composer!.value;
      composer!._valueTracker!.setValue(composer!.value);
    }
  });

  api.setValue(composer!, 'React must receive this message');

  expect(observedValue).toBe('React must receive this message');
});

it('ignores a hidden DeepSeek search textarea when locating the chat composer', () => {
  const { api, composer } = load([], { composerId: false, hiddenSearch: true });

  expect(api.composer()).toBe(composer);
});

it('does not mistake an aria-hidden search textarea with layout bounds for the chat composer', () => {
  const { api, composer } = load([], { composerId: false, hiddenSearch: 'aria-hidden' });

  expect(api.composer()).toBe(composer);
});

it('does not use a visible standalone search textarea as the chat composer', () => {
  const { api } = load([], { composer: false, hiddenSearch: 'visible' });

  expect(api.composer()).toBeNull();
});

it('finds and fills a contenteditable DeepSeek composer', () => {
  const edit = node('div', { class: 'ds-input__textarea', contenteditable: 'true', role: 'textbox' });
  const root = node('div', { class: 'ds-input' }, [edit]);
  const { api } = load([root], { composer: false });

  expect(api.composer()).toBe(edit);
  api.setValue(edit, 'Synthetic contenteditable message');
  expect(edit.textContent).toBe('Synthetic contenteditable message');
  expect(edit.innerText).toBe('Synthetic contenteditable message');
  expect(edit.events).toContain('input');
});

it('updates DeepSeek presence after the composer mounts after initial injection', async () => {
  const { api, document, presenceMessages, presenceObservers } = load([], { composer: false });
  expect(presenceMessages.at(-1)?.signedIn).toBe(false);

  const edit = node('div', { class: 'ds-input__textarea', contenteditable: 'plaintext-only', role: 'textbox' });
  document.body.appendChild(node('div', { class: 'ds-input' }, [edit]));
  presenceObservers[0]!.notify();

  expect(api.composer()).toBe(edit);
  await vi.waitFor(() => expect(presenceMessages.at(-1)?.signedIn).toBe(true));
});

it('refreshes an existing page adapter in place after DeepSeek SPA reinjection', () => {
  const { api, composer, context } = load([]);
  const previousSetter = vi.fn();
  (api as unknown as { setValue: typeof previousSetter }).setValue = previousSetter;

  vm.runInContext(domSource, context, { filename: 'deepseek-dom-reinjected.js' });

  expect((context as unknown as { NEURAFLOK_DEEPSEEK: DeepseekDomApi }).NEURAFLOK_DEEPSEEK).toBe(api);
  expect(api.setValue).not.toBe(previousSetter);
  api.setValue(composer!, 'fresh adapter after route change');
  expect(composer!.value).toBe('fresh adapter after route change');
});

it('waits for a long DeepSeek generation to finish before sending the next tool round', async () => {
  vi.useFakeTimers();
  try {
    const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
    const { listeners, send, stop } = load([assistant]);
    send.hidden = true;
    stop.hidden = false;
    setTimeout(() => {
      stop.hidden = true;
      send.hidden = false;
    }, 30_000);
    send.click = function click() {
      this.events.push('click');
      assistant.innerText = 'Tool round completed';
      assistant.textContent = assistant.innerText;
    };

    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000005',
      conversationId: SESSION_ID,
      text: 'continue the task'
    }, {}, value => { reply = value; });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(send.events).not.toContain('click');
    expect(reply).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.events).toContain('click');
    expect(reply).toMatchObject({ text: 'Tool round completed' });
  } finally {
    vi.useRealTimers();
  }
});

it('detects the provider Continue control used after a response reaches its output limit', () => {
  const continueButton = node('button', { text: 'Continue generating' });
  const { api } = load([continueButton]);
  expect(api.continueButton()).toBe(continueButton);
});

it('detects DeepSeek Continue rendered as ds-button__content inside a clickable wrapper', () => {
  const content = node('span', { class: 'ds-button__content', text: 'Continue' });
  const control = node('div', { class: 'ds-button' }, [content]);
  const { api } = load([control]);
  expect(api.continueButton()).toBe(control);
});

it('returns a temporary server failure with a Continue control as pending work', async () => {
  const { listeners, sessionStorage, send, document } = load([]);
  const error = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Servidor no disponible temporalmente.' });
  const continueButton = node('button', { text: 'Continuar' });
  send.click = () => {
    send.events.push('click');
    document.body.appendChild(error);
    document.body.appendChild(continueButton);
  };
  sessionStorage.setItem('neuraflok.providerSession', SESSION_ID);
  let reply: unknown;
  const requestId = '00000000-0000-4000-8000-000000000012';
  listeners[0]!({
    type: 'neuraflok-deepseek-complete', id: requestId, conversationId: SESSION_ID,
    text: 'Synthetic recovery check', fresh: false, before: '', beforeThink: '', beforeIdentity: ''
  }, {}, value => { reply = value; });

  await vi.waitFor(() => expect(reply).toMatchObject({
    pending: true, text: 'Servidor no disponible temporalmente.', continueAvailable: true, generating: false
  }), { timeout: 2_000 });
  expect(reply).not.toHaveProperty('error');
  expect(continueButton.events).not.toContain('click');
});

it('returns a Continue-only DeepSeek response promptly without waiting for answer text', async () => {
  vi.useFakeTimers();
  try {
    const { listeners, sessionStorage, send, document } = load([]);
    const content = node('span', { class: 'ds-button__content', text: 'Continue' });
    const control = node('div', { class: 'ds-button' }, [content]);
    send.click = () => {
      send.events.push('click');
      document.body.appendChild(control);
    };
    sessionStorage.setItem('neuraflok.providerSession', SESSION_ID);
    let reply: unknown;
    listeners[0]!({
      type: 'neuraflok-deepseek-complete',
      id: '00000000-0000-4000-8000-000000000014',
      conversationId: SESSION_ID,
      text: 'Continue the existing project task',
      fresh: false,
      before: '',
      beforeThink: '',
      beforeIdentity: ''
    }, {}, value => { reply = value; });

    await vi.advanceTimersByTimeAsync(500);

    expect(reply).toMatchObject({ pending: true, generating: false, continueAvailable: true });
    expect(reply).not.toHaveProperty('error');
  } finally {
    vi.useRealTimers();
  }
});

it('rebinds a tab only when the background worker proves the old project chat is saved', async () => {
  const oldConversation = 'ds-00000000-0000-0000-0000-000000000099';
  const oldMessage = node('div', { class: 'ds-message' }, [node('div', { class: 'ds-markdown', text: 'Saved older project answer' })]);
  const newChat = node('button', { text: 'New chat' });
  const { listeners, sessionStorage, send, document } = load([]);
  document.body.appendChild(oldMessage);
  document.body.appendChild(newChat);
  newChat.click = () => {
    newChat.events.push('click');
    document.body.children = document.body.children.filter(child => child !== oldMessage);
  };
  send.click = () => {
    send.events.push('click');
    document.body.appendChild(node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Fresh chat is ready.' }));
  };
  sessionStorage.setItem('neuraflok.providerSession', oldConversation);
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete', id: '00000000-0000-4000-8000-000000000013',
    conversationId: SESSION_ID, text: 'Synthetic fresh chat check', fresh: true,
    rebindSavedConversation: true, before: '', beforeThink: '', beforeIdentity: ''
  }, {}, value => { reply = value; });

  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'Fresh chat is ready.' }), { timeout: 2_000 });
  expect(newChat.events).toContain('click');
  expect(sessionStorage.getItem('neuraflok.providerSession')).toBe(SESSION_ID);
});

it('only clicks Continue for the currently bound session and send claim', () => {
  const content = node('span', { class: 'ds-button__content', text: 'Continue' });
  const continueButton = node('div', { class: 'ds-button' }, [content]);
  const { listeners, sessionStorage } = load([continueButton]);
  const requestId = '00000000-0000-4000-8000-000000000009';
  sessionStorage.setItem('neuraflok.providerSession', SESSION_ID);
  sessionStorage.setItem('neuraflok.sendClaim', requestId);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-continue', id: requestId, conversationId: SESSION_ID }, {}, value => { reply = value; });
  expect(reply).toEqual({ continued: true });
  expect(continueButton.events).toContain('click');
});

it('keeps a DeepSeek DSML tool call when it follows a planning sentence', () => {
  const response = [
    'We need to inspect the project first.',
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="read">',
    '<｜｜DSML｜｜ parameter name="arguments" string="false">{"paths":["/commander"]}</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>'
  ].join('\n');
  const { listeners } = load([node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: response })]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', sent: 'Inspect the project', before: '', beforeThink: '' }, {}, value => { reply = value; });
  expect(reply).toMatchObject({ answer: response });
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

it('finds the mounted composer while Electron restores its client layout', () => {
  const historyLink = node('a', { href: '/a/chat/s/00000000-0000-0000-0000-000000000001' });
  const { api, composer } = load([historyLink]);
  if (composer) composer.getClientRects = () => [];
  expect(api.composer()).toBe(composer);
  expect(api.signedIn()).toBe(true);
});

it('recognizes an authenticated workspace with DeepSeek\'s newer composer markup while layout is restoring', () => {
  const historyLink = node('a', { href: '/a/chat/s/00000000-0000-0000-0000-000000000001' });
  const { api, composer } = load([historyLink], { composerId: false });
  if (composer) composer.getClientRects = () => [];
  expect(api.composer()).toBe(composer);
  expect(api.signedIn()).toBe(true);
});

it('does not discard DeepSeek\'s message composer when its textarea is named search', () => {
  const { api, composer } = load([], { composerId: false, composerPlaceholder: 'Mensaje a DeepSeek' });

  expect(api.composer()).toBe(composer);
  expect(api.signedIn()).toBe(true);
});

it('recognizes the authenticated DeepSeek landing page before history links mount', () => {
  const composer = node('textarea');
  composer.getClientRects = () => [];
  const { api } = load([composer], { composer: false });

  expect(api.composer()).toBe(composer);
  expect(api.signedIn()).toBe(true);
});

it('does not treat DeepSeek email and password fields as a connected chat', () => {
  const email = node('input', { type: 'email', name: 'email' });
  const password = node('input', { type: 'password', name: 'password' });
  const { api } = load([email, password], { composer: false });

  expect(api.composer()).toBeNull();
  expect(api.signedIn()).toBe(false);
});

it('recognizes a signed-in workspace from conversation history even when new chat is not a button', () => {
  const newChat = node('div', { text: 'Nuevo chat' });
  const historyLink = node('a', { href: '/a/chat/s/00000000-0000-0000-0000-000000000001' });
  const { api } = load([newChat, historyLink], { composer: false });

  expect(api.composer()).toBeNull();
  expect(api.signedIn()).toBe(true);
});

it('finds DeepSeek editable controls inside an open shadow root while layout is restoring', () => {
  const shadowComposer = node('textarea');
  shadowComposer.getClientRects = () => [];
  const host = node('deepseek-composer');
  host.shadowRoot = node('div', {}, [shadowComposer]);
  const { api } = load([host], { composer: false });

  expect(api.composer()).toBe(shadowComposer);
  expect(api.signedIn()).toBe(true);
});

it('searches open shadow roots even when an unrelated top-level input exists', () => {
  const auxiliaryInput = node('input');
  auxiliaryInput.hidden = true;
  const shadowComposer = node('textarea');
  shadowComposer.getClientRects = () => [];
  const host = node('deepseek-composer');
  host.shadowRoot = node('div', {}, [shadowComposer]);
  const { api } = load([auxiliaryInput, host], { composer: false });

  expect(api.composer()).toBe(shadowComposer);
  expect(api.signedIn()).toBe(true);
});

it('prefers a visible shadow textarea over an unrelated top-level input', () => {
  const auxiliaryInput = node('input');
  const shadowComposer = node('textarea');
  const host = node('deepseek-composer');
  host.shadowRoot = node('div', {}, [shadowComposer]);
  const { api } = load([auxiliaryInput, host], { composer: false });

  expect(api.composer()).toBe(shadowComposer);
  expect(api.signedIn()).toBe(true);
});

it('can drive mounted composer and send controls when an inactive browser tab has no client rects', () => {
  const inactiveComposer = node('textarea', { id: 'chat-input' });
  inactiveComposer.getClientRects = () => [];
  const newChat = node('button', { text: 'Nuevo chat' });
  newChat.getClientRects = () => [];
  const { api, send, context } = load([inactiveComposer, newChat], { composer: false });
  send.getClientRects = () => [];
  context.document.visibilityState = 'hidden';

  expect(api.signedIn()).toBe(true);
  expect(api.composer()).toBe(inactiveComposer);
  expect(api.sendButton()).toBe(send);
  expect(api.newChat()).toBe(newChat);
});

it('drives layoutless controls when Electron leaves a background document marked visible', () => {
  const composer = node('textarea', { id: 'chat-input' });
  composer.getClientRects = () => [];
  const { api, send, context } = load([composer], { composer: false });
  send.getClientRects = () => [];
  context.document.visibilityState = 'visible';
  context.document.hidden = false;

  expect(api.composer()).toBe(composer);
  expect(api.sendButton()).toBe(send);
  expect(api.signedIn()).toBe(true);
});

it('does not treat CSS-hidden or disabled background controls as visible', () => {
  const hiddenComposer = node('textarea', { id: 'chat-input', hidden: 'true' });
  hiddenComposer.hidden = true;
  hiddenComposer.getClientRects = () => [];
  const { api, context } = load([hiddenComposer], { composer: false });
  context.document.visibilityState = 'hidden';

  expect(api.composer()).toBeNull();
});

it('answers neuraflok-deepseek-status and marks the page so the companion shows on DeepSeek', () => {
  const { listeners, document } = load([]);
  expect(listeners).toHaveLength(1);
  expect(document.getElementById('neuraflok-deepseek-badge')?.textContent).toBe('NEURAFLOK');
  let status: unknown;
  const kept = listeners[0]!({ type: 'neuraflok-deepseek-status' }, {}, (value) => { status = value; });
  expect(kept).toBeUndefined();
  expect(status).toEqual({ signedIn: true, generating: false, hasConversation: false, conversationId: null });
  const { listeners: signedOut, api } = load([], { composer: false });
  expect(api.signedIn()).toBe(false);
  signedOut[0]!({ type: 'neuraflok-deepseek-status' }, {}, (value) => { status = value; });
  expect(status).toEqual({ signedIn: false, generating: false, hasConversation: false, conversationId: null });
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

it('uses the rendered message key to distinguish a repeated answer in a new turn', () => {
  const previous = node('div', { key: 'assistant-old' }, [node('div', { class: 'ds-markdown', text: 'The same answer.' })]);
  const current = node('div', { key: 'assistant-new' }, [node('div', { class: 'ds-markdown', text: 'The same answer.' })]);
  const first = load([previous]).api.lastAnswerIdentity();
  const repeated = load([previous]).api.lastAnswerIdentity();
  const nextTurn = load([current]).api.lastAnswerIdentity();

  expect(first).toBe('message:assistant-old');
  expect(repeated).toBe(first);
  expect(nextTurn).toBe('message:assistant-new');
});

it('rejects the previous answer despite whitespace changes when reading an old chat', () => {
  const oldAnswer = node('div', { key: 'assistant-old' }, [node('div', { class: 'ds-markdown', text: 'Yesterday\'s answer.' })]);
  const { listeners } = load([oldAnswer]);
  let reply: unknown;

  listeners[0]!({
    type: 'neuraflok-deepseek-read',
    sent: 'What is new today?',
    before: 'Yesterday\'s   answer. ',
    beforeIdentity: 'message:assistant-old'
  }, {}, value => { reply = value; });

  expect(reply).toMatchObject({ answer: '', text: '' });
});

it('accepts an identical response text only after a new assistant message appears', () => {
  const currentAnswer = node('div', { key: 'assistant-current' }, [node('div', { class: 'ds-markdown', text: 'Yes, it is ready.' })]);
  const { listeners } = load([currentAnswer]);
  let reply: unknown;

  listeners[0]!({
    type: 'neuraflok-deepseek-read',
    sent: 'Please confirm.',
    before: 'Yes, it is ready.',
    beforeIdentity: 'message:assistant-previous'
  }, {}, value => { reply = value; });

  expect(reply).toMatchObject({ answer: 'Yes, it is ready.', answerIdentity: 'message:assistant-current' });
});

it('does not mistake a leftover spinner for active generation when Send is enabled', () => {
  const staleSpinner = node('div', { class: 'ds-loading' });
  const answer = node('div', { class: 'ds-assistant-message-main-content' }, [staleSpinner]);
  const { api } = load([answer]);

  expect(api.sendButton()).not.toBeNull();
  expect(api.generating()).toBe(false);
});

it('treats a streaming cursor as generating even when Send is still visible', () => {
  const cursor = node('div', { class: 'ds-cursor' });
  const { api, send } = load([cursor]);
  expect(api.sendButton()).toBe(send);
  expect(api.generating()).toBe(true);
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

it('retries insertion when DeepSeek replaces the composer during a React update', async () => {
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { api, composer, listeners, send } = load([assistant]);
  const replacement = node('textarea', { id: 'chat-input' });
  Object.setPrototypeOf(replacement, HTMLTextAreaElement.prototype);
  Reflect.deleteProperty(replacement, 'value');

  let liveComposer = composer;
  let insertions = 0;
  const setValue = api.setValue;
  api.composer = () => liveComposer;
  api.setValue = (target, text) => {
    insertions += 1;
    if (insertions === 1) {
      // Simulate DeepSeek replacing its controlled textarea after the first
      // input event, before the new node adopts React's state.
      liveComposer = replacement;
      return;
    }
    setValue(target, text);
  };
  send.click = function click() {
    this.events.push('click');
    assistant.textContent = 'Recovered reply';
    assistant.innerText = assistant.textContent;
  };

  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete',
    id: '00000000-0000-4000-8000-000000000010',
    conversationId: SESSION_ID,
    text: 'Synthetic follow-up'
  }, {}, value => { reply = value; });

  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'Recovered reply' }));
  expect(insertions).toBeGreaterThan(1);
  expect(replacement.value).toBe('Synthetic follow-up');
  expect(send.events).toContain('click');
});

it('accepts a multiline contenteditable when DeepSeek normalizes paragraph whitespace', async () => {
  const assistant = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: '' });
  const { api, listeners, send } = load([assistant]);
  const editable = node('div', { contenteditable: 'plaintext-only', role: 'textbox' });
  Reflect.deleteProperty(editable, 'value');
  const originalSetValue = api.setValue;
  api.composer = () => editable;
  api.setValue = (target, text) => {
    originalSetValue(target, text);
    // DeepSeek's editable can paint a pasted blank paragraph as one line break.
    target.innerText = target.textContent.replace(/\n{2,}/g, '\n');
  };
  send.click = function click() {
    this.events.push('click');
    assistant.textContent = 'Multiline message accepted';
    assistant.innerText = assistant.textContent;
  };

  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete',
    id: '00000000-0000-4000-8000-000000000011',
    conversationId: SESSION_ID,
    fresh: true,
    text: 'First line\n\nSecond line'
  }, {}, value => { reply = value; });

  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'Multiline message accepted' }));
  expect(send.events).toContain('click');
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

it('serializes code blocks from their pre text when assistant and block text differ', () => {
  const codeText = '#include <iostream>\nint main() {\n  return 0;\n}';
  const banner = node('div', { class: 'md-code-block-banner', text: 'cpp' });
  const copy = node('button', { text: 'Copy' });
  const code = node('pre', { text: codeText });
  const block = node('div', { class: 'md-code-block' }, [banner, copy, code]);
  block.innerText = `cpp\nCopy\n${codeText}\nsvgsvg`;
  block.textContent = block.innerText;
  const answer = node('div', { class: 'ds-assistant-message-main-content ds-markdown' }, [block]);
  answer.innerText = `An example.\n\ncpp\n${codeText}\nsvgsvg\n\nThat is the complete program.`;
  answer.textContent = answer.innerText;
  const { api } = load([answer]);

  const serialized = api.lastAnswer();
  expect(serialized).toContain('An example.');
  expect(serialized).toContain(`\`\`\`cpp\n${codeText}\n\`\`\``);
  expect(serialized).toContain('That is the complete program.');
  expect(serialized).not.toContain('Copy');
  expect(serialized).not.toContain('svgsvg');
  expect(serialized.match(/#include <iostream>/g)).toHaveLength(1);
});

it('keeps repeated code blocks in order and strips each DeepSeek toolbar', () => {
  const codeText = '#include <iostream>\nint main() {\n  std::cout << "same";\n}';
  const makeBlock = () => {
    const banner = node('div', { class: 'md-code-block-banner', text: 'cpp' });
    const copy = node('button', { text: 'Copy' });
    const code = node('pre', { text: codeText });
    const block = node('div', { class: 'md-code-block' }, [banner, copy, code]);
    block.innerText = `cpp\nCopy\n${codeText}\nsvgsvg`;
    block.textContent = block.innerText;
    return block;
  };
  const first = makeBlock();
  const second = makeBlock();
  const answer = node('div', { class: 'ds-assistant-message-main-content ds-markdown' }, [first, second]);
  answer.innerText = `First version.\n\ncpp\nCopy\n${codeText}\nsvgsvg\n\nSecond version.\n\ncpp\nCopy\n${codeText}\nsvgsvg`;
  answer.textContent = answer.innerText;
  const { api } = load([answer]);

  const serialized = api.lastAnswer();
  expect(serialized.indexOf('First version.')).toBeLessThan(serialized.indexOf('Second version.'));
  expect(serialized.match(/```cpp/g)).toHaveLength(2);
  expect(serialized.match(/#include <iostream>/g)).toHaveLength(2);
  expect(serialized).not.toContain('Copy');
  expect(serialized).not.toContain('svgsvg');
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
    expect(reply).toMatchObject({
      pending: true,
      text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}\n```',
      before: '',
      beforeThink: '',
      beforeIdentity: '',
      answerIdentity: expect.stringMatching(/^node:[^:]+:1$/),
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
  expect(reply).toMatchObject({
    signedIn: true, generating: false, hasConversation: true, conversationId: null,
    text: 'new think reply', answer: '', think: 'new think reply', answerIdentity: expect.stringMatching(/^node:[^:]+:1$/)
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
  const { listeners } = load([ack, plan]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'NEURAFLOK_READY', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({ answer: '' });
});

it('does not treat Spanish planning sentences as a public follow-up answer', () => {
  const ack = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'NEURAFLOK_READY' });
  const plan = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Voy a listar los archivos del proyecto.' });
  const { listeners } = load([ack, plan]);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-deepseek-read', before: 'NEURAFLOK_READY', beforeThink: '' }, {}, (value) => { reply = value; });
  expect(reply).toMatchObject({ answer: '' });
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
    signedIn: true, generating: false, hasConversation: true, conversationId: null,
    text: 'Este proyecto es Commander.js.',
    answer: 'Este proyecto es Commander.js.',
    think: 'The user asked for a summary.',
    answerIdentity: expect.stringMatching(/^node:[^:]+:1$/)
  });
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

it('chooses the labeled New chat control instead of the home link', () => {
  const home = node('a', { href: '/', text: 'Home' });
  const starter = node('button', { 'aria-label': 'New chat' });
  const { api } = load([home, starter]);

  expect(api.newChat()).toBe(starter);
});

it('finds DeepSeek New chat inside its custom ds-button wrapper', () => {
  const content = node('span', { class: 'ds-button__content', text: 'Nuevo chat' });
  const starter = node('div', { class: 'ds-button' }, [content]);
  const { api } = load([starter]);

  expect(api.newChat()).toBe(starter);
});

it('finds DeepSeek New chat when its sidebar exposes only an exact group label', () => {
  const label = node('span', { text: 'Nuevo chat' });
  const row = node('div', { role: 'group' }, [label]);
  row.textContent = 'Nuevo chat Ctrl + J';
  row.innerText = row.textContent;
  const { api } = load([row]);

  expect(api.newChat()).toBe(label);
});

it('finds DeepSeek New chat inside an open shadow root', () => {
  const content = node('span', { class: 'ds-button__content', text: 'Nuevo chat' });
  const starter = node('div', { class: 'ds-button' }, [content]);
  const host = node('div');
  host.shadowRoot = node('shadow-root', {}, [starter]);
  const { api } = load([host]);

  expect(api.newChat()).toBe(starter);
});

it('does not mistake assistant prose about a new chat for the sidebar control', () => {
  const prose = node('div', { class: 'ds-markdown', text: 'We should start a new chat after this task.' });
  const { api } = load([prose]);

  expect(api.newChat()).toBeNull();
});

it.each([
  { label: 'very short', question: 'Hi' },
  { label: 'very long', question: 'Please inspect the project context and propose a safe edit. '.repeat(400) }
])('takes the reply baseline after switching to a fresh conversation for a $label question', async ({ question }) => {
  const oldAnswer = node('div', { class: 'ds-assistant-message-main-content ds-markdown', text: 'Previous conversation answer' });
  const starter = node('button', { 'aria-label': 'New chat' });
  const { listeners, send, api, composer } = load([oldAnswer, starter]);
  const originalNewChatClick = starter.click.bind(starter);
  starter.click = function click() {
    originalNewChatClick();
    oldAnswer.textContent = '';
    oldAnswer.innerText = '';
  };
  let submitted = '';
  send.click = function click() {
    this.events.push('click');
    submitted = composer?.value ?? '';
    oldAnswer.textContent = 'Fresh conversation answer';
    oldAnswer.innerText = 'Fresh conversation answer';
  };

  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-deepseek-complete',
    id: '00000000-0000-4000-8000-000000000010',
    conversationId: SESSION_ID,
    text: question,
    fresh: true,
    before: 'Previous conversation answer',
    beforeIdentity: 'message:previous-answer'
  }, {}, value => { reply = value; });

  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'Fresh conversation answer' }));
  expect(submitted).toBe(question);
  expect(reply).toMatchObject({ before: '', beforeIdentity: '' });
  expect(api.lastAnswer()).toBe('Fresh conversation answer');
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
