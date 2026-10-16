import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalState = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    options: any;
    cols = 80;
    rows = 24;
    dataListener: (data: string) => void = () => undefined;
    keyListener: (event: any) => boolean = () => true;
    selected = '';
    output: string[] = [];
    disposed = false;

    constructor(options: any) {
      this.options = options;
      terminalState.instances.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    onData(listener: (data: string) => void): void { this.dataListener = listener; }
    attachCustomKeyEventHandler(listener: (event: any) => boolean): void { this.keyListener = listener; }
    hasSelection(): boolean { return this.selected.length > 0; }
    getSelection(): string { return this.selected; }
    focus(): void {}
    dispose(): void { this.disposed = true; }
    writeln(text: string): void { this.output.push(text); }
    write(text: string, callback?: () => void): void { this.output.push(text); callback?.(); }
  }

  return { Terminal: FakeTerminal };
});

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));

import { createWorkspaceTerminal } from '../frontend/features/workspace/terminal/composition.js';

describe('workspace terminal renderer', () => {
  let dom: JSDOM;
  let api: Record<string, any>;
  let terminalEvent: ((event: any) => void) | null;
  let nextId: number;

  beforeEach(() => {
    terminalState.instances.length = 0;
    terminalEvent = null;
    nextId = 0;
    dom = new JSDOM('<div class="app"></div><main id="mount"></main>', { pretendToBeVisual: true });
    api = {
      onTerminalEvent: vi.fn((listener: (event: any) => void) => { terminalEvent = listener; return vi.fn(); }),
      terminalCreate: vi.fn(async () => ({ ok: true, data: { shell: 'pwsh', cwd: 'C:\\project' } })),
      terminalClose: vi.fn(async () => undefined),
      terminalWrite: vi.fn(async () => ({ ok: true })),
      terminalResize: vi.fn(async () => undefined),
      terminalAck: vi.fn(async () => undefined),
      writeClipboard: vi.fn(async () => undefined)
    };
    Object.defineProperty(dom.window, 'api', { configurable: true, value: api });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
    vi.stubGlobal('crypto', { randomUUID: () => `terminal-${++nextId}` });
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  });

  afterEach(() => {
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('keeps xterm unloaded until a terminal tab is requested', () => {
    const workspace = createWorkspaceTerminal(vi.fn(), document.getElementById('mount')!);
    expect(terminalState.instances).toHaveLength(0);
    expect(api.terminalCreate).not.toHaveBeenCalled();
    workspace.update({ id: 'project-1', name: 'Alpha' } as any);
    expect(terminalState.instances).toHaveLength(0);
  });

  it('does not start a process when the window closes while xterm is loading', async () => {
    const workspace = createWorkspaceTerminal(vi.fn(), document.getElementById('mount')!);
    workspace.newTab();
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    await vi.dynamicImportSettled();
    expect(api.terminalCreate).not.toHaveBeenCalled();
    expect(terminalState.instances).toHaveLength(0);
  });

  it('creates a scoped terminal, sends input, acknowledges output, handles shortcuts, and closes cleanly', async () => {
    const mount = document.getElementById('mount')!;
    const onToggleBottom = vi.fn();
    const onEmpty = vi.fn();
    const workspace = createWorkspaceTerminal(onToggleBottom, mount, { onEmpty });
    workspace.update({ id: 'project-1', name: 'Alpha' } as any);
    workspace.show(mount);

    await vi.waitFor(() => expect(workspace.tabs()).toEqual([
      { id: 'terminal-1', title: 'Alpha · pwsh', exited: false }
    ]));
    expect(api.terminalCreate).toHaveBeenCalledWith('terminal-1', 'project-1', 80, 24);
    expect(mount.querySelector('.terminal-tab')?.textContent).toContain('Alpha · pwsh');

    const terminal = terminalState.instances[0]!;
    terminal.dataListener('echo hello');
    await vi.waitFor(() => expect(api.terminalWrite).toHaveBeenCalledWith('terminal-1', 'echo hello'));
    terminalEvent!({ id: 'terminal-1', data: 'hello' });
    expect(terminal.output).toContain('hello');
    expect(api.terminalAck).toHaveBeenCalledWith('terminal-1', 5);

    expect(terminal.keyListener({ type: 'keydown', ctrlKey: true, key: '`' })).toBe(false);
    expect(onToggleBottom).toHaveBeenCalledOnce();
    terminal.selected = 'selected text';
    expect(terminal.keyListener({ type: 'keydown', ctrlKey: true, shiftKey: true, code: 'KeyC' })).toBe(false);
    expect(api.writeClipboard).toHaveBeenCalledWith('selected text');

    workspace.closeTab('terminal-1');
    expect(terminal.disposed).toBe(true);
    expect(api.terminalClose).toHaveBeenCalledWith('terminal-1');
    expect(onEmpty).toHaveBeenCalledOnce();
  });
});
