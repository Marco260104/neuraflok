import { ComputerError } from './errors.js';
import type { Action } from './types.js';
import type { UiActionTarget } from './action-validation.js';

export function createActionMapper(
  uiTargets: Map<string, UiActionTarget>,
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number
): (action: Action) => Record<string, unknown> {
  return (action) => {
    switch (action.type) {
      case 'click_ref': {
        const target = requireUiTarget(uiTargets, action.ref);
        return {
          type: 'click_ui',
          window: target.window,
          snapshotId: target.snapshotId,
          runtimeKey: target.runtimeKey,
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.count === undefined ? {} : { count: action.count })
        };
      }
      case 'set_value': {
        const target = requireUiTarget(uiTargets, action.ref);
        return {
          type: 'set_value_ui',
          window: target.window,
          snapshotId: target.snapshotId,
          runtimeKey: target.runtimeKey,
          value: action.text
        };
      }
      case 'ui_action': {
        const target = requireUiTarget(uiTargets, action.ref);
        return { type: 'ui_action', window: target.window, snapshotId: target.snapshotId, runtimeKey: target.runtimeKey, action: action.action };
      }
      case 'launch_app':
        return { type: 'launch_app', app: action.app };
      case 'move':
      case 'click':
      case 'double_click':
        return {
          type: action.type,
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          button: 'button' in action ? (action.button ?? 'left') : 'left',
          ...(action.type === 'click' && action.count !== undefined ? { count: action.count } : {})
        };
      case 'scroll':
        return {
          type: 'scroll',
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          scroll_x: action.scroll_x ?? 0,
          scroll_y: action.scroll_y ?? 0,
          ...(action.scrollUnit === 'wheel' ? { rawWheel: true } : {})
        };
      case 'drag':
        return {
          type: 'drag',
          xs: action.path.map(point => toScreenX(point.x)),
          ys: action.path.map(point => toScreenY(point.y)),
          button: action.button ?? 'left',
          ...(action.duration_ms === undefined ? {} : { durationMs: action.duration_ms })
        };
      case 'type':
        return { type: 'type', text: action.text };
      case 'keypress':
        return { type: 'keypress', keys: action.keys };
      case 'focus':
        return { type: 'focus', window: action.window };
      default:
        throw new ComputerError('Unsupported action');
    }
  };
}

function requireUiTarget(uiTargets: Map<string, UiActionTarget>, ref: string): UiActionTarget {
  const target = uiTargets.get(ref);
  if (!target) throw new ComputerError(`UNKNOWN_UI_REF: ${ref}`);
  return target;
}
