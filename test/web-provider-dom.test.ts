import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../browser-extension/src/provider-pages/web/dom-adapter.js', import.meta.url), 'utf8');
const agentSource = readFileSync(new URL('../browser-extension/src/provider-pages/shared/delivery-agent.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../browser-extension/src/provider-pages/web/controller.js', import.meta.url), 'utf8');
const uuid = '00000000-0000-4000-8000-000000000001';

function mount(host: string, content = '', signedOut = false) {
  const dom = new JSDOM(`<!doctype html><html><body>
    ${content}
    <textarea aria-label="Search conversations" placeholder="Search"></textarea>
    <textarea id="composer" aria-label="Message" placeholder="Ask anything"></textarea>
    <button id="new-chat" aria-label="New chat">New chat</button>
    <button id="send" aria-label="Send message">Send</button>
    <button id="stop" aria-label="Stop generating" hidden>Stop</button>
    ${signedOut ? '<a href="/login">Sign in</a>' : ''}
  </body></html>`, { url: `https://${host}/`, runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value(this: HTMLElement) {
      return this.hidden || window.getComputedStyle(this).display === 'none' || window.getComputedStyle(this).visibility === 'hidden'
        ? [] : [{ width: 100, height: 24 }];
    }
  });
  window.eval(domSource);
  window.eval(agentSource);
  return { dom, window, api: (window as any).NEURAFLOK_PROVIDER };
}

it.each([
  ['www.kimi.com', 'kimi'],
  ['chat.qwen.ai', 'qwen'],
  ['z.ai', 'glm'],
  ['chat.z.ai', 'glm']
])('identifies the %s page and its signed-in message controls', (host, provider) => {
  const { dom, api } = mount(host, `
    <div data-message-author-role="user">old prompt</div>
    <div data-message-author-role="assistant" class="markdown-body">provider answer</div>`);
  expect(api.provider).toBe(provider);
  expect(api.signedIn()).toBe(true);
  expect(api.composer()?.id).toBe('composer');
  expect(api.sendButton()?.id).toBe('send');
  expect(api.newChat()?.id).toBe('new-chat');
  expect(api.hasConversation()).toBe(true);
  expect(api.lastAnswer()).toBe('provider answer');
  dom.window.close();
});

it('does not attach the generic adapter to an unsupported host', () => {
  const { dom, api } = mount('example.com');
  expect(api).toBeUndefined();
  dom.window.close();
});

it('does not mistake search or sign-in controls for a usable provider session', () => {
  const { dom, api } = mount('chat.qwen.ai', '', true);
  expect(api.composer()?.id).toBe('composer');
  expect(api.signedIn()).toBe(false);
  dom.window.close();
});

it('refreshes an existing web-provider adapter in place after SPA reinjection', () => {
  const { dom, api, window } = mount('chat.qwen.ai');
  const previousSetter = vi.fn();
  api.setValue = previousSetter;

  window.eval(domSource);

  expect((window as any).NEURAFLOK_PROVIDER).toBe(api);
  expect(api.setValue).not.toBe(previousSetter);
  api.setValue(api.composer(), 'fresh adapter after route change');
  expect(api.composer().value).toBe('fresh adapter after route change');
  dom.window.close();
});

it('reuses an existing companion mark after the page adapter is updated', () => {
  const { dom, window } = mount('chat.qwen.ai', '<div id="neural-jam-provider-mark">Old mark</div>');
  const listeners: Array<(message: any, sender: unknown, sendResponse: (value: unknown) => void) => unknown> = [];
  Object.assign(window, { chrome: { runtime: {
    lastError: null,
    sendMessage: (_message: unknown, callback?: () => void) => callback?.(),
    onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
  } } });
  window.eval(contentSource);
  expect(window.document.getElementById('neuraflok-provider-mark')?.textContent).toBe('NEURAFLOK · QWEN');
  expect(window.document.getElementById('neural-jam-provider-mark')).toBeNull();
  dom.window.close();
});

it('writes through the native textarea setter and ignores user-authored text as an answer', () => {
  const { dom, api, window } = mount('www.kimi.com', `
    <div data-message-author-role="user" class="message-content">question text</div>`);
  const input = api.composer();
  api.setValue(input, 'write a file');
  expect(input.value).toBe('write a file');
  expect(api.lastAnswer()).toBe('');
  expect(api.hasConversation()).toBe(true);
  expect(window.document.activeElement).toBe(input);
  dom.window.close();
});

it.each([
  ['www.kimi.com', 'kimi', 'km'],
  ['chat.qwen.ai', 'qwen', 'qw'],
  ['z.ai', 'glm', 'gm']
])('sends through a fresh %s page, waits for its new answer, and keeps provider identity', async (host, provider, prefix) => {
  const { dom, window, api } = mount(host, `<div data-message-author-role="user" class="old-message">older question</div>`);
  const sent: unknown[] = [];
  const listeners: Array<(message: any, sender: unknown, sendResponse: (value: unknown) => void) => unknown> = [];
  Object.assign(window, {
    chrome: { runtime: {
      lastError: null,
      sendMessage: (_message: unknown, callback?: () => void) => callback?.(),
      onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
    } }
  });
  window.eval(contentSource);
  window.document.getElementById('new-chat')!.addEventListener('click', () => {
    window.document.querySelectorAll('.old-message').forEach(node => node.remove());
  });
  window.document.getElementById('send')!.addEventListener('click', () => {
    sent.push(api.composer().value);
    const stop = window.document.getElementById('stop')!;
    stop.hidden = false;
    setTimeout(() => {
      const answer = window.document.createElement('div');
      answer.setAttribute('data-message-author-role', 'assistant');
      answer.className = 'message-content';
      answer.textContent = 'A new provider reply';
      window.document.body.append(answer);
      stop.hidden = true;
    }, 10);
  });
  const message = {
    type: 'neuraflok-provider-complete', provider, id: uuid,
    conversationId: `${prefix}-${uuid}`, fresh: true, text: 'write a file'
  };
  let reply: unknown;
  const kept = listeners[0]!(message, {}, value => { reply = value; });
  expect(kept).toBe(true);
  await vi.waitFor(() => expect(reply).toMatchObject({ text: 'A new provider reply' }), { timeout: 5_000 });
  expect(sent).toEqual(['write a file']);
  expect(window.sessionStorage.getItem(`neuraflok.session.${provider}`)).toBe(`${prefix}-${uuid}`);
  expect(window.sessionStorage.getItem(`neuraflok.sendClaim.${provider}`)).toBe(uuid);
  dom.window.close();
});

it('migrates a bound provider session and pending claim from the previous storage namespace', async () => {
  const { dom, window } = mount('chat.qwen.ai');
  const listeners: Array<(message: any, sender: unknown, sendResponse: (value: unknown) => void) => unknown> = [];
  Object.assign(window, { chrome: { runtime: {
    lastError: null,
    sendMessage: (_message: unknown, callback?: () => void) => callback?.(),
    onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
  } } });
  const previousClaim = '00000000-0000-4000-8000-000000000009';
  window.sessionStorage.setItem('neuraljam.session.qwen', `qw-${uuid}`);
  window.sessionStorage.setItem('neuraljam.sendClaim.qwen', previousClaim);
  window.eval(contentSource);
  let reply: unknown;
  listeners[0]!({ type: 'neuraflok-provider-complete', provider: 'qwen', id: previousClaim, conversationId: `qw-${uuid}`, text: 'retry' }, {}, value => { reply = value; });
  await vi.waitFor(() => expect(reply).toMatchObject({ pending: true }));
  expect(window.sessionStorage.getItem('neuraflok.session.qwen')).toBe(`qw-${uuid}`);
  expect(window.sessionStorage.getItem('neuraflok.sendClaim.qwen')).toBe(previousClaim);
  expect(window.sessionStorage.getItem('neuraljam.session.qwen')).toBeNull();
  expect(window.sessionStorage.getItem('neuraljam.sendClaim.qwen')).toBeNull();
  dom.window.close();
});

it('refuses to send a fresh provider session into an old conversation without a working new-chat control', async () => {
  const { dom, window } = mount('chat.qwen.ai', `<div data-message-author-role="assistant" class="message-content">old answer</div>`);
  const listeners: Array<(message: any, sender: unknown, sendResponse: (value: unknown) => void) => unknown> = [];
  Object.assign(window, { chrome: { runtime: {
    lastError: null,
    sendMessage: (_message: unknown, callback?: () => void) => callback?.(),
    onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
  } } });
  window.eval(contentSource);
  window.document.getElementById('new-chat')!.remove();
  let sent = 0;
  window.document.getElementById('send')!.addEventListener('click', () => sent++);
  let reply: unknown;
  listeners[0]!({
    type: 'neuraflok-provider-complete', provider: 'qwen', id: uuid,
    conversationId: `qw-${uuid}`, fresh: true, text: 'do not append here'
  }, {}, value => { reply = value; });
  await vi.waitFor(() => expect(reply).toMatchObject({ error: expect.stringMatching(/new-chat control/i) }));
  expect(sent).toBe(0);
  expect(window.sessionStorage.getItem('neuraflok.session.qwen')).toBeNull();
  dom.window.close();
});
