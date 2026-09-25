import { ComputerError, getWindowState } from '../../../device-control/native/index.js';
import { browserTabChord, isBrowserProcess } from '../../../device-control/native/browser-chords.js';
import { parseWindowsKeyChord } from '../../../device-control/native/windows-api.js';
import { fail, type ToolResult } from '../kernel.js';

export async function refuseBrowserChord(key: string, window: { id: number }): Promise<string | null> {
  const chord = browserTabChord(parseWindowsKeyChord(key));
  if (!chord) return null;
  const target = (await getWindowState({ window: window.id, includeScreenshot: false, includeUi: false })).window;
  if (!isBrowserProcess(target.process)) return null;
  return `BROWSER_TAB_CHORD: ${chord} manages browser tabs/windows or history in ${JSON.stringify(target.title)} (${target.process}). No keys were sent. Use browser_tabs list to choose an exact tab; browser_snapshot reads it directly. Use browser_tabs new for a requested test page, or attach then browser_navigate for an existing eligible tab. These operations run in the background without changing the user's selected tab.`;
}

export function nativeFailure(error: unknown): ToolResult | null {
  if (!(error instanceof ComputerError)) return null;
  const code = /^(?:PARTIAL_BATCH:[^\r\n]*?\. )?([A-Z][A-Z0-9_]*):/.exec(error.message)?.[1];
  if (!code) return null;
  let recovery: string;
  switch (code) {
    case 'CAPTURE_FAILED':
      recovery = 'Use get_window_state({window,include_screenshot:false,include_text:true}) for accessible controls. Inspect list_windows for the current state. A minimized target can be restored with activate_window when needed for the task, then observed again. Repeating the same capture cannot restore it.';
      break;
    case 'WINDOW_NOT_FOUND':
    case 'STALE_WINDOW':
    case 'WINDOW_APP_MISMATCH':
    case 'RELATED_WINDOW_GONE':
      recovery = 'Call list_windows and select the current returned app/window identity. A closed window or dialog needs a new target; do not reuse its old id.';
      break;
    case 'FOCUS_FAILED':
      recovery = 'Call list_windows to inspect the foreground and get_window_state on the target and its owned dialogs. Resolve the relevant dialog or window state before another action.';
      break;
    case 'STALE_FRAME':
    case 'STALE_SCREENSHOT':
    case 'STALE_WINDOW_STATE':
    case 'STALE_REF':
    case 'STALE_UI_REF':
    case 'STALE_UI_SNAPSHOT':
    case 'UNKNOWN_UI_REF':
      recovery = 'Call get_window_state on the current target and inspect the result. Choose fresh screenshot coordinates or indexes from include_text:true; the previous observation no longer authorizes input.';
      break;
    case 'ELEMENT_NOT_FOUND':
      recovery = 'Use get_window_state with include_text:true and query (control name or automation id) or role to locate the control beyond a truncated tree. Use an index from that new result.';
      break;
    case 'UIA_FAILED':
      recovery = 'Use get_window_state({window,include_text:false}) to inspect the target pixels. An unavailable accessibility provider does not imply screenshots or other tools are disabled.';
      break;
    default:
      return null;
  }
  const detail = { code, message: error.message, recovery, completed_count: error.completedCount ?? null,
    failed_index: error.failedIndex ?? null, completed_routes: error.completedRoutes ?? null };
  return { ...fail(`${error.message}\nNext step: ${recovery}\nDo not repeat completed input. Inspect the current result before deciding which action is still needed.`),
    structuredContent: { error: detail } };
}
