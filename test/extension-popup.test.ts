import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const root = new URL('../browser-extension/', import.meta.url);
const html = await readFile(new URL('src/popup/index.html', root), 'utf8');
const css = await readFile(new URL('src/popup/styles.css', root), 'utf8');
const script = await readFile(new URL('src/popup/controller.js', root), 'utf8');
const i18nScript = await readFile(new URL('src/popup/localization.js', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
let popup: JSDOM | undefined;

afterEach(() => { popup?.window.close(); });

function createPopup(options: {
  status?: Record<string, unknown>;
  tab?: Record<string, unknown>;
  openProviderReply?: Record<string, unknown>;
  onPair?: () => void;
} = {}) {
  let status = options.status ?? {
    connected: true, paired: true, compatible: true, port: 8765,
    pending: 0, appVersion: '0.1.0', extensionVersion: '0.1.0'
  };
  const tab = options.tab ?? { provider: null, webProviders: {} };
  const sent: Array<Record<string, unknown>> = [];
  popup = new JSDOM(html, { url: 'chrome-extension://test/src/popup/index.html', runScripts: 'outside-only' });
  const sendMessage = vi.fn(async (message: { type: string }) => {
    sent.push(message);
    if (message.type === 'status') return status;
    if (message.type === 'tabStatus') return tab;
    if (message.type === 'pair') {
      options.onPair?.();
      status = { ...status, connected: true, paired: true, compatible: true };
      return { ok: true };
    }
    if (message.type === 'open_provider') return options.openProviderReply ?? { ok: true, reused: false };
    return { ok: false };
  });
  Object.assign(popup.window, {
    chrome: {
      runtime: { sendMessage, lastError: null },
      storage: {
        local: { get: async () => ({ appLanguage: 'es' }) },
        onChanged: { addListener: vi.fn() }
      }
    },
    setInterval: () => 0
  });
  popup.window.eval(i18nScript);
  popup.window.eval(script);
  return { document: popup.window.document, sent, sendMessage };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it('packages the NEURAFLOK popup and declares bounded provider and bridge hosts', async () => {
  expect(manifest.name).toBe('__MSG_extension_name__');
  expect(manifest.action.default_popup).toBe('src/popup/index.html');
  expect(manifest.host_permissions.filter((entry: string) => entry.startsWith('https://'))).toEqual([
    'https://chat.deepseek.com/*', 'https://kimi.com/*', 'https://www.kimi.com/*',
    'https://chat.qwen.ai/*', 'https://z.ai/*', 'https://chat.z.ai/*', 'https://chatglm.cn/*', 'https://www.chatglm.cn/*'
  ]);
  expect(manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js)).not.toContain('i18n.js');
  for (const file of [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((entry: { js: string[]; css?: string[] }) => [...entry.js, ...(entry.css ?? [])])]) {
    await expect(access(new URL(String(file), root))).resolves.toBeUndefined();
  }
  await expect(access(new URL('src/popup/localization.js', root))).resolves.toBeUndefined();
  expect(html).toContain('<title>NEURAFLOK</title>');
  expect(html).toContain('id="activeMark" class="provider-code">NF</span>');
  expect(i18nScript).toContain('Sistema activo');
  expect(html).toContain('id="thinkingIndicator"');
  expect(html).toContain('data-provider="kimi"');
  expect(css).toMatch(/@keyframes\s+thinking-bar/);
  expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
});

it('shows the provider session and animates the real generating state', async () => {
  const session = 'km-12345678-1234-1234-1234-123456789abc';
  const { document } = createPopup({
    tab: {
      provider: 'kimi', conversationId: session,
      page: { signedIn: true, generating: true, conversationId: session },
      webProviders: {
        deepseek: { open: true, signedIn: true },
        kimi: { open: true, signedIn: true },
        qwen: { open: true, signedIn: false },
        glm: { open: false, signedIn: null }
      }
    }
  });
  await flush();
  expect(document.getElementById('state')!.textContent).toBe('Sistema activo');
  expect(document.getElementById('activeProvider')!.textContent).toBe('Kimi');
  expect(document.getElementById('activeLabel')!.textContent).toBe('Respondiendo');
  expect(document.getElementById('activeDetail')!.textContent).toContain('km-1234567');
  expect((document.getElementById('thinkingIndicator') as HTMLElement).hidden).toBe(false);
  expect(document.querySelector('[data-provider="kimi"]')!.getAttribute('data-state')).toBe('ready');
  expect(document.querySelector('[data-provider="qwen"]')!.getAttribute('data-state')).toBe('login');
  expect(document.getElementById('providerCount')!.textContent).toBe('2 de 4 activos');
});

it('distinguishes an unsigned provider tab from a verified session', async () => {
  const { document } = createPopup({
    tab: {
      provider: 'qwen', page: { signedIn: false, generating: false },
      webProviders: { qwen: { open: true, signedIn: false } }
    }
  });
  await flush();
  expect(document.querySelector('[data-provider="qwen"]')!.getAttribute('data-state')).toBe('login');
  expect(document.getElementById('activeLabel')!.textContent).toBe('Inicia sesión');
  expect((document.getElementById('thinkingIndicator') as HTMLElement).hidden).toBe(true);
  expect(document.getElementById('providerCount')!.textContent).toBe('0 de 4 activos');
});

it('delegates provider tab selection to the extension worker', async () => {
  const { document, sendMessage } = createPopup();
  await flush();
  expect(document.querySelector('[data-provider="deepseek"]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-open-provider="kimi"]')!.click();
  await flush();
  expect(sendMessage).toHaveBeenCalledWith({ type: 'open_provider', provider: 'kimi' });
  expect(document.getElementById('footerState')!.textContent).toBe('Kimi está abierto en el navegador.');
  expect(script).not.toContain('chrome.tabs.');
});

it('shows the actual provider-tab error returned by the worker', async () => {
  const { document } = createPopup({
    openProviderReply: { ok: false, error: 'open_failed', detail: 'Tabs API is unavailable in this context.' }
  });
  await flush();
  document.querySelector<HTMLButtonElement>('[data-open-provider="glm"]')!.click();
  await flush();
  expect(document.getElementById('footerState')!.textContent).toBe(
    'No se pudo abrir Z AI: El navegador rechazó la apertura de la pestaña. Tabs API is unavailable in this context.'
  );
});

it('explains how to recover when the integrated browser does not answer', async () => {
  const { document, sendMessage } = createPopup();
  sendMessage.mockImplementation(async (message: any) => {
    if (message.type === 'open_provider') throw new Error('Receiving end does not exist.');
    return { ok: true };
  });
  await flush();
  document.querySelector<HTMLButtonElement>('[data-open-provider="deepseek"]')!.click();
  await flush();
  expect(document.getElementById('footerState')!.textContent).toBe(
    'No se pudo abrir DeepSeek: El navegador integrado no respondió. Reinicia NEURAFLOK y vuelve a intentarlo. Receiving end does not exist.'
  );
});

it('explains automatic companion recovery after a protocol mismatch', async () => {
  const { document } = createPopup({
    status: {
      connected: true, paired: false, compatible: false, port: 8765,
      appVersion: '0.1.0', extensionVersion: '2.1.31', appProtocol: 15, extensionProtocol: 14
    }
  });
  await flush();
  expect(document.getElementById('state')!.textContent).toContain('no coincide');
  expect(document.getElementById('alert')!.textContent).toContain('15 / 14');
  expect(document.getElementById('appHint')!.textContent).toContain('Reinicia NEURAFLOK');
  expect(document.getElementById('appHint')!.textContent).toContain('navegador integrado');
  expect((document.getElementById('retryBtn') as HTMLButtonElement).hidden).toBe(true);
});

it('re-pairs the browser bridge through the explicit retry action', async () => {
  const { document, sendMessage } = createPopup({
    status: { connected: true, paired: false, compatible: true, disconnected: true, port: 8765 }
  });
  await flush();
  const retry = document.getElementById('retryBtn') as HTMLButtonElement;
  expect(retry.hidden).toBe(false);
  expect(retry.textContent).toBe('Conectar');
  retry.click();
  await flush();
  await flush();
  expect(sendMessage).toHaveBeenCalledWith({ type: 'pair' });
  expect(document.getElementById('state')!.textContent).toBe('Sistema activo');
});
