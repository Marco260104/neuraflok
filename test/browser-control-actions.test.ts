import { expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createBrowserActions } from '../browser-extension/src/background/browser/control/input/actions.js';

const viewport = { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 2 };

function setup() {
  const dependencies = {
    authorize: vi.fn(async (_command: unknown) => undefined),
    currentTab: vi.fn(async (_state: unknown, _command: unknown) => undefined),
    send: vi.fn(async (_state: unknown, method: string, _params: Record<string, unknown>, _sessionId?: string, _command?: unknown): Promise<Record<string, unknown>> => method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { ...viewport } } : {}),
    input: vi.fn(async (_state: unknown, _method: string, _params: Record<string, unknown>, _command?: unknown) => undefined),
    page: vi.fn(async (_state: unknown, method: string, _params: Record<string, unknown>, _command?: unknown) => method === 'point' ? { x: 12, y: 18 } : undefined),
    frameList: vi.fn(async (_state: unknown) => [{ frameId: 'frame-0' }]),
    context: vi.fn(async (_state: unknown, _frameId: string) => ({ id: 1 })),
    cut: (value: unknown) => String(value ?? '').slice(0, 180),
    error: (message: string): never => { throw new Error(message); },
    handle: (tabId: number) => `browser:${tabId}`
  };
  const actions = createBrowserActions(dependencies);
  const state = {
    tabId: 17,
    pageId: 'page-1',
    refFrames: new Map<string, string>(),
    frames: new Map<string, { id: string; parentId?: string; sessionId?: string }>(),
    screenshot: { id: 'shot-1', pageId: 'page-1', fullPage: false, width: 400, height: 300, scale: 2, viewport: { ...viewport } },
    dialog: { type: 'confirm' } as { type: string } | null
  };
  return { actions, state, dependencies, command: { id: 'call-1' } };
}

it('scales viewport screenshot coordinates and dispatches every requested click', async () => {
  const { actions, state, dependencies, command } = setup();
  await expect(actions.action(state, { action: 'click', screenshotId: 'shot-1', x: 20, y: 10, clickCount: 2 }, command))
    .resolves.toMatchObject({ tabId: 'browser:17', pageId: 'page-1', accepted: true });
  expect(dependencies.input).toHaveBeenCalledWith(state, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 5 }, command);
  expect(dependencies.input.mock.calls.filter(([, , event]) => event.type === 'mousePressed').map(([, , event]) => event.clickCount)).toEqual([1, 2]);
  expect(dependencies.send.mock.calls.filter(([, method]) => method === 'Input.dispatchMouseEvent').map(([, , event]) => event.type)).toEqual(['mouseReleased', 'mouseReleased']);
  expect(state.screenshot).toBeNull();
});

it('refuses stale, full-page, changed-viewport, and out-of-image coordinates', async () => {
  const first = setup();
  await expect(first.actions.point(first.state, { screenshotId: 'old', x: 1, y: 1 }, first.command)).rejects.toThrow('BROWSER_SCREENSHOT_STALE');
  first.state.screenshot.fullPage = true;
  await expect(first.actions.point(first.state, { screenshotId: 'shot-1', x: 1, y: 1 }, first.command)).rejects.toThrow('BROWSER_SCREENSHOT_STALE');

  const changed = setup();
  changed.dependencies.send.mockImplementationOnce(async () => ({ cssVisualViewport: { ...viewport, pageX: 1 } }));
  await expect(changed.actions.point(changed.state, { screenshotId: 'shot-1', x: 1, y: 1 }, changed.command)).rejects.toThrow('BROWSER_VIEWPORT_CHANGED');

  const outside = setup();
  await expect(outside.actions.point(outside.state, { screenshotId: 'shot-1', x: 400, y: 1 }, outside.command)).rejects.toThrow('BROWSER_COORDINATES_OUTSIDE_IMAGE');
});

it('resolves nested-frame refs, checks their parent widget, and releases temporary frame objects', async () => {
  const { actions, state, dependencies, command } = setup();
  state.refFrames.set('page-1:button', 'child');
  state.frames.set('root', { id: 'root', sessionId: 'root-session' });
  state.frames.set('child', { id: 'child', parentId: 'root', sessionId: 'child-session' });
  dependencies.frameList.mockResolvedValue([{ frameId: 'root' }]);
  dependencies.send.mockImplementation(async (_state, method, params) => {
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 3 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'frame-owner' } };
    if (method === 'Runtime.callFunctionOn') {
      const value = (params.arguments as Array<{ value?: unknown }> | undefined)?.[0]?.value;
      return { result: { value: value === null ? null : { x: 120, y: 180 } } };
    }
    return {};
  });
  await expect(actions.point(state, { ref: 'page-1:button' }, command)).resolves.toEqual({ x: 12, y: 18, __sessionId: 'child-session' });
  expect(dependencies.context).toHaveBeenCalledWith(state, 'root');
  expect(dependencies.send).toHaveBeenCalledWith(state, 'DOM.getFrameOwner', { frameId: 'child' }, 'root-session', command);
  expect(dependencies.send).toHaveBeenCalledWith(state, 'Runtime.releaseObject', { objectId: 'frame-owner' }, 'root-session');
});

it('sends normalized key chords and releases the key after its tab navigates', async () => {
  const { actions, state, dependencies, command } = setup();
  await actions.action(state, { action: 'key', key: 'Ctrl+Shift+Return' }, command);
  expect(dependencies.input).toHaveBeenCalledWith(state, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 10
  }, command);
  expect(dependencies.send).toHaveBeenCalledWith(state, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 10
  });

  const navigating = setup();
  navigating.dependencies.input.mockImplementationOnce(async () => { navigating.state.pageId = 'page-2'; });
  await navigating.actions.action(navigating.state, { action: 'key', key: 'Escape' }, navigating.command);
  expect(navigating.dependencies.send).toHaveBeenCalledWith(navigating.state, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0
  });
});

it('focuses editable refs, replaces on fill, types literal text, and clears with Backspace', async () => {
  const { actions, state, dependencies, command } = setup();
  state.refFrames.set('page-1:input', 'frame-0');
  await actions.action(state, { action: 'fill', ref: 'page-1:input', text: 'next' }, command);
  expect(dependencies.page).toHaveBeenCalledWith(state, 'focus', { ref: 'page-1:input', frameId: 'frame-0', replace: true }, command);
  expect(dependencies.input).toHaveBeenCalledWith(state, 'Input.insertText', { text: 'next' }, command);

  await actions.action(state, { action: 'type', ref: 'page-1:input', text: '!' }, command);
  expect(dependencies.page).toHaveBeenCalledWith(state, 'focus', { ref: 'page-1:input', frameId: 'frame-0', replace: false }, command);
  expect(dependencies.input).toHaveBeenCalledWith(state, 'Input.insertText', { text: '!' }, command);

  await actions.action(state, { action: 'fill', ref: 'page-1:input', text: '' }, command);
  expect(dependencies.input).toHaveBeenCalledWith(state, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, command);
  expect(dependencies.send).toHaveBeenCalledWith(state, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
});

it('selects exact option values and handles only an observed JavaScript dialog', async () => {
  const { actions, state, dependencies, command } = setup();
  await actions.action(state, { action: 'select', ref: 'page-1:select', values: ['draft', 'ready'] }, command);
  expect(dependencies.currentTab).toHaveBeenCalledWith(state, command);
  expect(dependencies.page).toHaveBeenCalledWith(state, 'select', { ref: 'page-1:select', frameId: undefined, values: ['draft', 'ready'] }, command);

  await actions.action(state, { action: 'dialog', accept: false, text: 'cancel' }, command);
  expect(dependencies.input).toHaveBeenCalledWith(state, 'Page.handleJavaScriptDialog', { accept: false, promptText: 'cancel' }, command);
  state.dialog = null;
  await expect(actions.action(state, { action: 'dialog', accept: true }, command)).rejects.toThrow('BROWSER_DIALOG_REQUIRED');
});

it('scrolls and drags within one unchanged screenshot viewport, always releasing the pointer', async () => {
  const scroll = setup();
  await scroll.actions.action(scroll.state, { action: 'scroll', screenshotId: 'shot-1', x: 20, y: 10, deltaX: 4, deltaY: -12 }, scroll.command);
  expect(scroll.dependencies.input).toHaveBeenCalledWith(scroll.state, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 10, y: 5, deltaX: 4, deltaY: -12
  }, scroll.command);

  const drag = setup();
  await drag.actions.action(drag.state, { action: 'drag', screenshotId: 'shot-1', x: 20, y: 10, toX: 80, toY: 50 }, drag.command);
  const moves = drag.dependencies.input.mock.calls.filter(([, , event]) => event.type === 'mouseMoved');
  expect(moves).toHaveLength(13);
  expect(drag.dependencies.send).toHaveBeenCalledWith(drag.state, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 40, y: 25, button: 'left', clickCount: 1
  });
});
