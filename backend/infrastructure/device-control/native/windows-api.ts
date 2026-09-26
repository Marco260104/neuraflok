import type { z } from 'zod';
import { act, ComputerError, getWindowState, listDesktopApps, listWindows, type Action } from './index.js';
import {
  WINDOWS_API_SCHEMAS,
  type WindowsComputerBackend,
  type WindowsWindow,
  type WindowsWindowState
} from './windows-api-contract.js';
import { actionLabel, projectWindowObservation, publicWindow, targetableWindows, type WindowObservationState } from './windows-api-observation.js';

export { WINDOWS_API_METHODS, WINDOWS_API_SCHEMAS } from './windows-api-contract.js';
export type { WindowsComputerBackend, WindowsWindow, WindowsWindowState } from './windows-api-contract.js';

/** Parse the shared key chord format and retain a literal plus as one key. */
export function parseWindowsKeyChord(key: string): string[] {
  const parts = key.trim().split('+').map(part => part.trim());
  if (parts.length >= 2 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '+');
  if (parts.length > 6 || parts.some(part => !part || part.length > 20)) {
    throw new ComputerError('INVALID_KEY: use up to six key names; write the plus key as plus or Control_L++.');
  }
  return parts;
}

/** Create a caller-scoped adapter with bounded observation authority. */
export function createWindowsComputerApi(
  backend: WindowsComputerBackend = { act, getWindowState, listDesktopApps, listWindows }
) {
  const observations = new Map<number, { state?: WindowObservationState }>();
  const parse = <K extends keyof typeof WINDOWS_API_SCHEMAS>(method: K, input: unknown): z.infer<(typeof WINDOWS_API_SCHEMAS)[K]> =>
    WINDOWS_API_SCHEMAS[method].parse(input ?? {}) as z.infer<(typeof WINDOWS_API_SCHEMAS)[K]>;

  async function current(window: WindowsWindow): Promise<void> {
    const result = await backend.getWindowState({ window: window.id, includeScreenshot: false, includeUi: false, includeRelated: false });
    const found = publicWindow(result.window);
    if (found.app !== window.app) throw new ComputerError('STALE_WINDOW: app identity changed; get the window again.');
  }

  function stateFor(window: WindowsWindow): WindowObservationState {
    const state = observations.get(window.id)?.state;
    if (!state || state.app !== window.app) {
      throw new ComputerError('STALE_WINDOW_STATE: call get_window_state before using indexes or coordinates.');
    }
    return state;
  }

  function element(window: WindowsWindow, index: number) {
    const reference = stateFor(window).refs[index];
    if (!reference) throw new ComputerError('ELEMENT_NOT_FOUND: index is absent from the latest window state.');
    return reference;
  }

  function coordinate(window: WindowsWindow, id: string | undefined, x: number, y: number) {
    const state = stateFor(window);
    const frame = state.frames.get(id ?? state.primary ?? '');
    if (!frame || frame.windowId === null) {
      throw new ComputerError('STALE_SCREENSHOT: screenshotId is absent from the latest window state.');
    }
    x = Math.round(x);
    y = Math.round(y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
      throw new ComputerError('COORDINATE_OUT_OF_BOUNDS: use coordinates inside the selected screenshot region.');
    }
    const options = {
      frameId: frame.frameId,
      window: frame.windowId,
      app: frame.app,
      ...(frame.windowId === window.id ? {} : { ownerWindow: window.id, ownerApp: window.app })
    };
    return { x, y, options };
  }

  async function mutate(window: WindowsWindow | undefined, action: Action, options?: Parameters<typeof act>[1]) {
    const expected = window ? observations.get(window.id) : undefined;
    if (window) await current(window);
    if (window && observations.get(window.id) !== expected) {
      throw new ComputerError('STALE_WINDOW_STATE: observation changed before input.');
    }
    observations.clear();
    await backend.act([action], options ?? (window ? { window: window.id, app: window.app } : {}));
  }

  return {
    target: 'windows' as const,

    async list_windows(input: unknown = {}): Promise<WindowsWindow[]> {
      parse('list_windows', input);
      return targetableWindows((await backend.listWindows()).windows);
    },

    async get_window(input: unknown): Promise<WindowsWindow> {
      const args = parse('get_window', input);
      const result = await backend.getWindowState({ window: args.id, includeScreenshot: false, includeUi: false, includeRelated: false });
      const found = publicWindow(result.window);
      if (args.app !== undefined && args.app !== found.app) throw new ComputerError('WINDOW_NOT_FOUND: app does not own this window.');
      return found;
    },

    async list_apps(input: unknown = {}) {
      parse('list_apps', input);
      const result = await backend.listDesktopApps({ limit: 4096 });
      if (result.truncated) throw new ComputerError('APP_LIST_TRUNCATED: native app catalog exceeded its bounded result.');
      return result.apps.map(app => ({
        id: app.id,
        displayName: app.displayName,
        isRunning: app.isRunning ?? (app.windows?.length ?? 0) > 0,
        windows: targetableWindows(app.windows ?? [])
      }));
    },

    async launch_app(input: unknown): Promise<void> {
      const args = parse('launch_app', input);
      await mutate(undefined, { type: 'launch_app', app: args.app });
    },

    async get_window_state(input: unknown): Promise<WindowsWindowState> {
      const args = parse('get_window_state', input);
      const includeScreenshot = args.include_screenshot !== false;
      const hasTextOptions = args.query !== undefined || args.role !== undefined || args.max_elements !== undefined;
      const includeUi = args.include_text ?? hasTextOptions;
      if (hasTextOptions && !includeUi) {
        throw new ComputerError('INVALID_ARGUMENT: query, role and max_elements need include_text:true, or omit include_text.');
      }
      if (!includeScreenshot && !includeUi) {
        throw new ComputerError('At least one of include_screenshot or include_text must be true.');
      }

      const pending: { state?: WindowObservationState } = {};
      observations.delete(args.window.id);
      observations.set(args.window.id, pending);
      while (observations.size > 32) observations.delete(observations.keys().next().value!);

      const result = await backend.getWindowState({
        window: args.window.id,
        includeScreenshot,
        includeUi,
        includeRelated: includeScreenshot,
        maxElements: args.max_elements ?? 100,
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.role === undefined ? {} : { role: args.role })
      });
      if (observations.get(args.window.id) !== pending) {
        throw new ComputerError('STALE_WINDOW_STATE: observation was superseded.');
      }
      const projected = projectWindowObservation(args.window, result, includeUi);
      pending.state = projected.state;
      return projected.response;
    },

    async click(input: unknown): Promise<void> {
      const args = parse('click', input);
      const aliases: Record<string, string> = { l: 'left', r: 'right', m: 'middle' };
      const button = aliases[args.mouse_button ?? 'left'] ?? args.mouse_button ?? 'left';
      if (args.element_index !== undefined) {
        if (args.x !== undefined || args.y !== undefined || args.screenshotId !== undefined) {
          throw new ComputerError('Choose element_index or screenshot coordinates.');
        }
        await mutate(args.window, {
          type: 'click_ref',
          ref: element(args.window, args.element_index).ref,
          button,
          count: args.click_count ?? 1
        });
        return;
      }
      if (args.x === undefined || args.y === undefined) throw new ComputerError('Coordinate click requires x and y.');
      const point = coordinate(args.window, args.screenshotId, args.x, args.y);
      await mutate(args.window, {
        type: 'click', x: point.x, y: point.y, button, count: args.click_count ?? 1
      }, point.options);
    },

    async press_key(input: unknown): Promise<void> {
      const args = parse('press_key', input);
      await mutate(args.window, { type: 'keypress', keys: parseWindowsKeyChord(args.key) });
    },

    async type_text(input: unknown): Promise<void> {
      const args = parse('type_text', input);
      const type = /[\r\n]/.test(args.text) ? 'paste' : 'type';
      await mutate(args.window, { type, text: args.text });
    },

    async scroll(input: unknown): Promise<void> {
      const args = parse('scroll', input);
      const point = coordinate(args.window, args.screenshotId, args.x, args.y);
      await mutate(args.window, {
        type: 'scroll', x: point.x, y: point.y,
        scroll_x: Math.round(args.scrollX), scroll_y: Math.round(args.scrollY), scrollUnit: 'wheel'
      }, point.options);
    },

    async set_value(input: unknown): Promise<void> {
      const args = parse('set_value', input);
      await mutate(args.window, { type: 'set_value', ref: element(args.window, args.element_index).ref, text: args.value });
    },

    async drag(input: unknown): Promise<void> {
      const args = parse('drag', input);
      const from = coordinate(args.window, args.screenshotId, args.from_x, args.from_y);
      const to = coordinate(args.window, args.screenshotId, args.to_x, args.to_y);
      await mutate(args.window, {
        type: 'drag', path: [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]
      }, from.options);
    },

    async perform_secondary_action(input: unknown): Promise<void> {
      const args = parse('perform_secondary_action', input);
      const reference = element(args.window, args.element_index);
      const action = reference.actions.find(candidate => actionLabel(candidate).toLowerCase() === args.action.trim().toLowerCase());
      if (!action) throw new ComputerError('ACTION_UNAVAILABLE: choose an action label from the latest element.');
      await mutate(args.window, { type: 'ui_action', ref: reference.ref, action });
    },

    async activate_window(input: unknown): Promise<void> {
      const args = parse('activate_window', input);
      await mutate(args.window, { type: 'focus', window: args.window.id });
    }
  };
}

export type WindowsComputerApi = ReturnType<typeof createWindowsComputerApi>;
