import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension scripts are plain JavaScript and are exercised directly here.
import { stageDeepseekAttachmentsInMainWorld, stageDeepseekFilesInMainWorld } from '../browser-extension/src/background/providers/execution/deepseek-main-world-attachments.js';

afterEach(() => vi.unstubAllGlobals());

function pageFixture(accept = 'image/*') {
  const events: string[] = [];
  const input = {
    disabled: false,
    files: [] as Array<{ name: string; type: string; size: number; parts?: Uint8Array[] }>,
    getAttribute(name: string) { return name === 'accept' ? accept : null; },
    dispatchEvent(event: { type: string }) { events.push(event.type); return true; }
  };
  const document = {
    querySelectorAll(selector: string) { return selector === 'input[type="file"]' ? [input] : []; }
  };
  class PageFile {
    readonly size: number;
    constructor(readonly parts: Uint8Array[], readonly name: string, readonly options: { type: string }) {
      this.size = parts.reduce((size, part) => size + part.byteLength, 0);
    }
    get type() { return this.options.type; }
  }
  class PageDataTransfer {
    private readonly selected: Array<{ name: string; type: string; size: number; parts?: Uint8Array[] }> = [];
    readonly items = { add: (file: { name: string; type: string; size: number; parts?: Uint8Array[] }) => this.selected.push(file) };
    get files() { return this.selected; }
  }
  vi.stubGlobal('document', document);
  vi.stubGlobal('File', PageFile);
  vi.stubGlobal('DataTransfer', PageDataTransfer);
  vi.stubGlobal('Event', class { constructor(readonly type: string) {} });
  return { input, events };
}

it('creates and dispatches an image file in the DeepSeek page world', () => {
  const { input, events } = pageFixture();
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const result = stageDeepseekFilesInMainWorld([{
    id: 'image-id', name: 'probe.png', mimeType: 'image/png', size: bytes.length,
    chunks: [Buffer.from(bytes).toString('base64')]
  }]);

  expect(result).toEqual({ ok: true });
  expect(input.files).toMatchObject([{ name: 'probe.png', type: 'image/png', size: 4 }]);
  expect(events).toEqual(['input', 'change']);
});

it('keeps a successful image stage when DeepSeek clears the file input in its change handler', () => {
  const events: string[] = [];
  const input = {
    disabled: false,
    files: [] as Array<{ name: string; type: string; size: number }>,
    getAttribute(name: string) { return name === 'accept' ? 'image/*' : null; },
    dispatchEvent(event: { type: string }) {
      events.push(event.type);
      if (event.type === 'change') this.files = [];
      return true;
    }
  };
  class PageFile {
    readonly size: number;
    constructor(readonly parts: Uint8Array[], readonly name: string, readonly options: { type: string }) {
      this.size = parts.reduce((size, part) => size + part.byteLength, 0);
    }
    get type() { return this.options.type; }
  }
  class PageDataTransfer {
    private readonly selected: Array<{ name: string; type: string; size: number }> = [];
    readonly items = { add: (file: { name: string; type: string; size: number }) => this.selected.push(file) };
    get files() { return this.selected; }
  }
  vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector === 'input[type="file"]' ? [input] : [] });
  vi.stubGlobal('File', PageFile);
  vi.stubGlobal('DataTransfer', PageDataTransfer);
  vi.stubGlobal('Event', class { constructor(readonly type: string) {} });

  const result = stageDeepseekFilesInMainWorld([{
    id: 'image-id', name: 'probe.png', mimeType: 'image/png', size: 4,
    chunks: [Buffer.from([1, 2, 3, 4]).toString('base64')]
  }]);

  expect(result).toEqual({ ok: true });
  expect(events).toEqual(['input', 'change']);
  expect(input.files).toEqual([]);
});

it('does not report success when DeepSeek has no compatible file input', () => {
  const { input, events } = pageFixture('.pdf');
  const result = stageDeepseekFilesInMainWorld([{
    id: 'image-id', name: 'probe.png', mimeType: 'image/png', size: 4,
    chunks: [Buffer.from([1, 2, 3, 4]).toString('base64')]
  }]);

  expect(result).toEqual({ ok: false });
  expect(input.files).toEqual([]);
  expect(events).toEqual([]);
});

it('injects the staging helper into the target DeepSeek tab main world', async () => {
  pageFixture();
  const executeScript = vi.fn(async ({ func, args }: { func: (...values: unknown[]) => unknown; args: unknown[] }) => [
    { result: func(...args) }
  ]);
  const chrome = { scripting: { executeScript } };
  const attachments = [{ id: 'image-id', name: 'probe.png', mimeType: 'image/png', size: 3, chunks: ['AQID'] }];

  await expect(stageDeepseekAttachmentsInMainWorld(chrome, 37, attachments)).resolves.toBe(true);
  expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
    target: { tabId: 37 }, world: 'MAIN', func: stageDeepseekFilesInMainWorld, args: [attachments]
  }));
});
