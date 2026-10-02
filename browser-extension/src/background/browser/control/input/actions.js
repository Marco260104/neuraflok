import { createBrowserPointResolver } from './coordinates.js';
import { keyEvents } from './keyboard.js';

export function createBrowserActions(dependencies) {
  const { authorize, currentTab, send, input, page, error, handle } = dependencies;
  const point = createBrowserPointResolver(dependencies);

  async function dispatchDialog(state, args, command) {
    if (typeof args.accept !== 'boolean' || !state.dialog) {
      error('BROWSER_DIALOG_REQUIRED: inspect pending dialog and specify accept.');
    }
    await input(state, 'Page.handleJavaScriptDialog', { accept: args.accept, promptText: args.text || '' }, command);
  }

  async function dispatchKey(state, args, command) {
    const key = keyEvents(args.key, error);
    if (args.ref) {
      await authorize(command);
      await page(state, 'focus', { ref: args.ref, frameId: state.refFrames?.get(args.ref), keyTarget: true }, command);
    }
    await input(state, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key }, command);
    const { text: _text, ...release } = key;
    try {
      if (args.holdMs) await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, args.holdMs))));
    } finally {
      await send(state, 'Input.dispatchKeyEvent', { type: 'keyUp', ...release });
    }
  }

  async function dispatchText(state, args, command, replace) {
    if (typeof args.text !== 'string' || !args.ref) error('BROWSER_TEXT_TARGET_REQUIRED: pass text and an editable ref.');
    await authorize(command);
    await page(state, 'focus', { ref: args.ref, frameId: state.refFrames?.get(args.ref), replace }, command);
    if (replace && !args.text) {
      await input(state, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, command);
      await send(state, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    } else {
      await input(state, 'Input.insertText', { text: args.text }, command);
    }
  }

  async function dispatchSelection(state, args, command) {
    if (!args.ref || !Array.isArray(args.values)) error('BROWSER_SELECT_REQUIRED: pass ref and values.');
    await authorize(command);
    await currentTab(state, command);
    await page(state, 'select', { ref: args.ref, frameId: state.refFrames?.get(args.ref), values: args.values }, command);
  }

  async function dispatchPointer(state, args, command) {
    const from = await point(state, args, command);
    if (args.action === 'scroll') {
      await input(state, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', ...from, deltaX: args.deltaX || 0, deltaY: args.deltaY || 0
      }, command);
      return;
    }
    await input(state, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from }, command);
    if (args.action === 'click') {
      const button = args.button || 'left';
      for (let count = 1; count <= (args.clickCount || 1); count += 1) {
        await input(state, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button, clickCount: count }, command);
        await send(state, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...from, button, clickCount: count });
      }
      return;
    }
    if (args.action === 'drag') {
      const to = await point(state, { ref: args.toRef, x: args.toX, y: args.toY, screenshotId: args.screenshotId }, command);
      if (to.__sessionId !== from.__sessionId) error('BROWSER_DRAG_FRAME: use one viewport screenshot for a drag across frame widgets.');
      const checkedFrom = await point(state, { ...args, noScroll: true }, command);
      if (checkedFrom.x !== from.x || checkedFrom.y !== from.y) error('BROWSER_DRAG_MOVED: choose endpoints in one viewport screenshot.');
      await input(state, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 }, command);
      try {
        for (let step = 1; step <= 12; step += 1) {
          await input(state, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', ...from,
            x: from.x + (to.x - from.x) * step / 12,
            y: from.y + (to.y - from.y) * step / 12,
            button: 'left', buttons: 1
          }, command);
        }
      } finally {
        await send(state, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 }).catch(() => {});
      }
      return;
    }
    if (args.action !== 'hover') error('BROWSER_ACTION_UNKNOWN');
  }

  async function action(state, args, command) {
    if (args.action === 'dialog') await dispatchDialog(state, args, command);
    else if (args.action === 'key') await dispatchKey(state, args, command);
    else if (args.action === 'fill') await dispatchText(state, args, command, true);
    else if (args.action === 'type') await dispatchText(state, args, command, false);
    else if (args.action === 'select') await dispatchSelection(state, args, command);
    else await dispatchPointer(state, args, command);
    state.screenshot = null;
    return {
      tabId: handle(state.tabId),
      pageId: state.pageId,
      accepted: true,
      message: 'Input dispatched; observe the page to verify the effect.'
    };
  }

  return { point, action };
}
