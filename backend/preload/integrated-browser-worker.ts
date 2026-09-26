// Exposes embedded-browser tab, window, alarm, and debugger adapters to the companion extension worker.
import { contextBridge, ipcRenderer } from 'electron';
import { installChromeShim } from './integrated-browser/chrome-api-shim.js';

type Reply = { ok: true; value: unknown } | { ok: false; message: string };

// Retry only the brief startup window before the app registers its IPC handler.
async function invoke(name: string, args: unknown[]): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ipcRenderer.invoke('integrated-browser:api', name, args) as Reply;
    } catch (error) {
      if (attempt >= 40 || !/No handler registered/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

// Read the service worker protocol from its own execution world.
const workerProtocol: unknown = contextBridge.executeInMainWorld({ func: () => globalThis.location?.protocol });
if (workerProtocol === 'chrome-extension:') {
  const subscribers = new Set<(name: string, args: unknown[]) => void>();
  ipcRenderer.on('integrated-browser:event', (_event, name: string, args: unknown[]) => {
    for (const subscriber of subscribers) subscriber(name, args);
  });
  contextBridge.exposeInMainWorld('__integratedBrowserWorker', {
    call: async (name: string, args: unknown[]): Promise<unknown> => {
      const reply = await invoke(name, args);
      // Chrome's exact messages, such as "No tab with id: 7.", reach the extension unchanged.
      if (!reply.ok) throw new Error(reply.message);
      return reply.value;
    },
    subscribe: (subscriber: (name: string, args: unknown[]) => void): void => { subscribers.add(subscriber); }
  });
  contextBridge.executeInMainWorld({ func: installChromeShim, args: [process.env.INTEGRATED_BROWSER_TRACE === '1'] });
}

