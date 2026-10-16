import type { UiActionName, WindowInfo } from './index.js';
import { ComputerError } from './index.js';
import type { NativeWindowObservation, WindowsWindow, WindowsWindowState } from './windows-api-contract.js';

const ACTION_LABELS: Record<UiActionName, string> = {
  invoke: 'Invoke', toggle: 'Toggle', select: 'Select', expand: 'Expand', collapse: 'Collapse', focus: 'Raise',
  scroll_up: 'Scroll Up', scroll_down: 'Scroll Down', scroll_left: 'Scroll Left', scroll_right: 'Scroll Right', scroll_into_view: 'Scroll Into View'
};

export interface WindowFrame {
  frameId: number;
  width: number;
  height: number;
  windowId: number | null;
  app: string;
}

export interface WindowObservationState {
  app: string;
  frames: Map<string, WindowFrame>;
  primary?: string;
  refs: Array<{ ref: string; actions: UiActionName[] }>;
}

export interface ProjectedWindowObservation {
  window: WindowsWindow;
  state: WindowObservationState;
  response: WindowsWindowState;
}

export function publicWindow(value: WindowInfo): WindowsWindow {
  const app = value.app || value.appUserModelId || value.processPath;
  if (!app) throw new ComputerError('WINDOW_IDENTITY_UNAVAILABLE: observe a window with an exact native app identity.');
  return { app, id: value.id, title: value.title, ...(value.state ? { state: value.state } : {}) };
}

export function targetableWindows(values: WindowInfo[]): WindowsWindow[] {
  return values.filter(value => value.app || value.appUserModelId || value.processPath).map(publicWindow);
}

export function projectWindowObservation(
  requested: WindowsWindow,
  result: NativeWindowObservation,
  includeUi: boolean
): ProjectedWindowObservation {
  const window = publicWindow(result.window);
  if (window.app !== requested.app) throw new ComputerError('STALE_WINDOW: app identity changed.');

  const state: WindowObservationState = {
    app: window.app,
    frames: new Map(),
    refs: result.elements.map(element => ({ ref: element.ref, actions: [...(element.actions ?? [])] }))
  };
  const screenshots: WindowsWindowState['screenshots'] = [];
  const frames = [
    { shot: result.screenshot, owner: result.window, primary: true },
    ...(result.related ?? []).slice().reverse().map(item => ({ shot: item.screenshot, owner: item.window, primary: false }))
  ];
  for (const frame of frames) {
    const shot = frame.shot;
    if (!shot) continue;
    const id = `frame-${shot.frameId}`;
    state.frames.set(id, {
      frameId: shot.frameId,
      width: shot.width,
      height: shot.height,
      windowId: shot.windowId,
      app: publicWindow(frame.owner).app
    });
    if (frame.primary) state.primary = id;
    screenshots.push({
      id,
      url: `data:image/png;base64,${shot.data}`,
      width: shot.width,
      height: shot.height,
      originX: shot.region.x,
      originY: shot.region.y,
      zIndex: screenshots.length
    });
  }

  const lines = result.elements.map((element, index) => {
    const depth = '\t'.repeat(Math.min(30, element.depth ?? 0));
    const actions = element.actions?.length ? ` [${element.actions.map(action => ACTION_LABELS[action]).join(', ')}]` : '';
    const offscreen = element.offscreen ? ' [offscreen]' : '';
    const disabled = element.enabled === false ? ' [disabled]' : '';
    const noPixels = element.bounds.width <= 0 || element.bounds.height <= 0 ? ' [no pixel bounds]' : '';
    return `${depth}${index}: ${element.role} ${JSON.stringify(element.name)}${actions}${offscreen}${disabled}${noPixels}`;
  });
  const focusedIndex = result.elements.findIndex(element => element.ref === result.accessibility?.focusedElement || element.focused);
  const selected = lines.filter((_line, index) => result.elements[index]?.selected);
  const accessibility = !includeUi || result.uiUnavailable ? null : {
    truncated: result.uiTruncated ?? null,
    tree: lines.join('\n'),
    ...(result.accessibility?.documentText === undefined ? {} : { document_text: result.accessibility.documentText }),
    ...(focusedIndex < 0 ? {} : { focused_element: lines[focusedIndex] }),
    ...(selected.length ? { selected_elements: selected } : {}),
    ...(result.accessibility?.selectedText === undefined ? {} : { selected_text: result.accessibility.selectedText })
  };

  return {
    window,
    state,
    response: {
      window,
      focused: result.screenshot?.focused ?? (result.window.state ? result.window.state === 'foreground' : null),
      screenshots,
      ...(result.screenshotUnavailable ? { screenshot_error: result.screenshotUnavailable } : {}),
      ...(includeUi && result.uiUnavailable ? { accessibility_error: result.uiUnavailable } : {}),
      accessibility
    }
  };
}

export function actionLabel(action: UiActionName): string {
  return ACTION_LABELS[action];
}
