import type { ActionRoute } from './errors.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  /** Windows native app identity (AUMID or exact process image path). */
  app?: string;
  processId?: number;
  processPath?: string;
  appUserModelId?: string;
  dpi?: number;
  title: string;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: 'foreground' | 'minimized' | 'open';
}

export interface UiElementInfo {
  /** Opaque state-scoped reference accepted by click_ref/set_value. */
  ref: string;
  name: string;
  role: string;
  automationId: string;
  enabled: boolean;
  offscreen: boolean;
  bounds: Rect;
  /** Present when the element is fully inside the most recent screenshot frame. */
  imageBounds: Rect | null;
  imageCenter: { x: number; y: number } | null;
  /** Native accessibility actions advertised by this control, when available. */
  actions?: UiActionName[];
  depth?: number;
  focused?: boolean;
  selected?: boolean;
}

export type UiActionName = 'invoke' | 'toggle' | 'select' | 'expand' | 'collapse' | 'focus'
  | 'scroll_up' | 'scroll_down' | 'scroll_left' | 'scroll_right' | 'scroll_into_view';

export interface DesktopApp { id: string; displayName: string; isRunning?: boolean; windows?: WindowInfo[] }

export interface AccessibilityContext {
  documentText?: string;
  selectedText?: string;
  focusedElement?: string;
}

export interface Screenshot {
  /** Base64 PNG. */
  data: string;
  /** Stable id for the coordinate frame used by later pointing actions. */
  frameId: number;
  /** Size of the returned image, which is what coordinates refer to. */
  width: number;
  height: number;
  /** The screen region it shows, in the helper's coordinate space. */
  region: Rect;
  scale: number;
  /** For a window capture: whether that window was actually in front when the pixels were taken. Null for whole-screen captures, where the question does not arise. Window capture never activates its target. False means it was not foreground; this is harmless for direct background capture and relevant only when captureMode says the helper had to fall back to visible screen pixels. */
  focused: boolean | null;
  /** How window pixels were obtained; screen_fallback can be occluded. */
  captureMode: 'screen' | 'window' | 'screen_fallback';
  /** Window id whose geometry this frame is bound to, if any. */
  windowId: number | null;
}

export interface ActionResult {
  cursor: PointerResult | null;
  clipboard: string[];
  completedCount: number;
  routes: ActionRoute[];
}

export type VerificationSpec =
  | { until: 'foreground'; window: number; timeoutMs?: number }
  | { until: 'window_exists'; match: string; timeoutMs?: number }
  | { until: 'window_closed'; match: string; timeoutMs?: number }
  | { until: 'ui_appears'; window?: number; match: string; role?: string; timeoutMs?: number }
  | { until: 'ui_disappears'; window?: number; match: string; role?: string; timeoutMs?: number };

export interface VerificationResult {
  until: VerificationSpec['until'];
  elapsedMs: number;
  detail: string;
  snapshotId: number | null;
}

export type Action =
  | { type: 'click_ref'; ref: string; button?: string; count?: number }
  | { type: 'set_value'; ref: string; text: string }
  | { type: 'ui_action'; ref: string; action: UiActionName }
  | { type: 'launch_app'; app: string }
  | { type: 'paste'; text: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: string; count?: number }
  | { type: 'double_click'; x: number; y: number; button?: string }
  | { type: 'scroll'; x: number; y: number; scroll_x?: number; scroll_y?: number; scrollUnit?: 'wheel' }
  | { type: 'drag'; path: Array<{ x: number; y: number }>; button?: string; duration_ms?: number }
  | { type: 'type'; text: string }
  | { type: 'keypress'; keys: string[] }
  | { type: 'focus'; window: number }
  | { type: 'wait'; ms?: number }
  // Clipboard actions stay ordered with native actions under the same desktop lock.
  | { type: 'read_clipboard' }
  | { type: 'write_clipboard'; text: string };

export interface PointerResult {
  screen: { x: number; y: number };
  image: { x: number; y: number } | null;
  frameId: number | null;
  imageSize: { width: number; height: number } | null;
}

export type { ActionRoute };
