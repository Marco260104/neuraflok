import { z } from 'zod';
import { WINDOWS_COMPUTER_METHODS } from '../../../../contracts/windows-computer/operation-policy.js';
import type { act, getWindowState, listDesktopApps, listWindows } from './index.js';
import type { WindowInfo } from './index.js';

const windowSchema = z.object({ app: z.string().min(1), id: z.number().int().positive(), title: z.string().optional() });
const point = { x: z.number().finite(), y: z.number().finite() };
const wheelDelta = z.number().finite().min(-1_200_000).max(1_200_000);
const screenshotId = z.string().min(1).optional();

export const WINDOWS_API_SCHEMAS = {
  list_windows: z.object({}),
  get_window: z.object({ id: z.number().int().positive(), app: z.string().min(1).optional() }),
  list_apps: z.object({}),
  launch_app: z.object({ app: z.string().min(1).max(32768) }),
  get_window_state: z.object({ window: windowSchema, include_screenshot: z.boolean().optional(), include_text: z.boolean().optional(), query: z.string().max(256).optional(), role: z.string().max(100).optional(), max_elements: z.number().int().min(1).max(100).optional() }),
  click: z.object({ window: windowSchema, click_count: z.number().int().min(1).max(3).optional(), element_index: z.number().int().nonnegative().optional(), mouse_button: z.enum(['left', 'right', 'middle', 'l', 'r', 'm']).optional(), screenshotId, x: point.x.optional(), y: point.y.optional() }),
  press_key: z.object({ window: windowSchema, key: z.string().min(1).max(200) }),
  type_text: z.object({ window: windowSchema, text: z.string().max(100000) }),
  scroll: z.object({ window: windowSchema, screenshotId, ...point, scrollX: wheelDelta, scrollY: wheelDelta }),
  set_value: z.object({ window: windowSchema, element_index: z.number().int().nonnegative(), value: z.string().max(100000) }),
  drag: z.object({ window: windowSchema, from_x: point.x, from_y: point.y, to_x: point.x, to_y: point.y, screenshotId }),
  perform_secondary_action: z.object({ window: windowSchema, element_index: z.number().int().nonnegative(), action: z.string().min(1).max(100) }),
  activate_window: z.object({ window: windowSchema })
} as const;

export const WINDOWS_API_METHODS = WINDOWS_COMPUTER_METHODS;
export type WindowsWindow = z.infer<typeof windowSchema> & { state?: WindowInfo['state'] };

export interface WindowsWindowState {
  window: WindowsWindow;
  focused: boolean | null;
  accessibility: null | { tree: string; truncated: boolean | null; document_text?: string; focused_element?: string; selected_elements?: string[]; selected_text?: string };
  accessibility_error?: { code: string; message: string };
  screenshot_error?: { code: string; message: string };
  screenshots: Array<{ id: string; url: string; width: number; height: number; originX: number; originY: number; zIndex: number }>;
}

export interface WindowsComputerBackend {
  act: typeof act;
  getWindowState: typeof getWindowState;
  listDesktopApps: typeof listDesktopApps;
  listWindows: typeof listWindows;
}

export type NativeWindowObservation = Awaited<ReturnType<WindowsComputerBackend['getWindowState']>>;
