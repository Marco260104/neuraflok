import { CODE_MODE_INSTRUCTIONS } from '../code-mode-tool.js';
import type { ToolContext } from '../kernel.js';
import { userInstructions } from './user-instructions.js';

export function desktopInstructions(ctx: ToolContext, platform: NodeJS.Platform): string {
  if (platform === 'win32') return windowsDesktopInstructions();
  const host = platform === 'darwin' ? 'Mac' : 'Windows PC';
  const paste = platform === 'darwin' ? 'command+v' : 'ctrl+v';
  const lines = [
    `Local desktop control: look at this ${host}’s screen and windows, and drive its mouse and keyboard.`,
    '',
    'observe first, then computer. Choose the task-specific window from observe what=windows, then inspect it with what=window.',
    'A bare observe() returns the foreground window, its screenshot and accessibility controls. Observation does not activate the window.',
    'Use click_ref/set_value for exposed controls; refs resolve the same control again when acted on.',
    'Physical input requires the target window in front. Use computer focus to activate it; when something steals focus, observe first.',
    'Coordinates are pixels of a screenshot frame. Coordinate actions require frameId so a click cannot land on a screen',
    'whose owner or geometry has since changed. Batch related actions and use captureAfter to inspect the result; input acceptance alone does not prove the task succeeded.',
    'Do not poll with a batch that only waits. When an action needs time to take effect, say what you are',
    'waiting for with verify — until foreground, window_exists, window_closed, ui_appears or ui_disappears —',
    'and it waits for that condition and captures the result inside the same call.',
    'The clipboard lives in computer too — read_clipboard and write_clipboard run in sequence with',
    `the other actions, so copying text in and pasting it with keypress ${paste} is one call.`,
    'A browser window may hold another user session. Open the page you are testing in a',
    'browser window of its own, keep that window in front and act only there. Keyboard chords that close, open',
    'or switch tabs or windows are refused. Address-bar focus chords are allowed for authorized navigation in the selected window.',

    'Act only on what the user asked for and leave the rest of their desktop alone.'
  ];

  if (ctx.privacyScreenshots) {
    lines.push(
      '',
      'Privacy screenshots are on: captures default to the active window rather than the whole screen.'
    );
  }

  lines.push(
    '',
    'File and command tools are available in this local workspace when enabled.'
  );

  lines.push('', CODE_MODE_INSTRUCTIONS, ...userInstructions());

  return lines.join('\n');
}

function windowsDesktopInstructions(): string {
  return [
    'Windows Computer Use uses the Window2 app/window interface. Use its named tools directly or call the same methods on sky inside this connector’s exec JavaScript. sky is supplied automatically; no package import or setup is needed. Mac uses a separate contract.',
    '',
    'Start with list_apps: each app has an id and its exact windows. list_windows lists currently open targetable windows; get_window rehydrates a returned id and optional app. Returned state distinguishes foreground, open and minimized. Choose exactly one returned Window {app,id,title?}; never invent an app/window identity from a title or guessed process name.',
    'launch_app accepts an observed app id or a concrete .exe path/name. It requests launch without command arguments. Refresh list_apps/list_windows and choose the matching returned window to verify startup; launch acceptance is not a window receipt.',
    '',
    'get_window_state({window}) captures the selected window without activating it, including when covered. include_screenshot defaults true and include_text defaults false. include_text adds a formatted accessibility tree with numeric element indexes, supported secondary-action labels, focused/selected elements and bounded document/selected text. Use include_screenshot:false for text-only observation.',
    'For a truncated tree, use get_window_state({window,query:"control name or automation id",role:"Button",max_elements:20,include_screenshot:false}). query and role are case-insensitive substring filters applied during traversal; max_elements bounds matching results to 1–100. These options imply include_text:true unless explicitly disabled. Use indexes from this new result. Controls marked no pixel bounds remain usable through their advertised semantic actions, without coordinate clicks.',
    'The result has {window,focused,screenshots,accessibility}. focused reports the observed window focus, not a promise that it stays focused. Screenshot metadata has an id, image-pixel width/height, physical screen origin and relative zIndex. Pixels are separate native image blocks, not data URLs in the returned object. Images appear directly for named tool calls and automatically for sky.get_window_state; text(state) safely prints only metadata. Owned menus/popups are bounded additional screenshots; a window in the same process is not automatically related.',
    'Chromium accessibility comes from its current browser UI, including the address bar and displayed document. accessibility.truncated marks an incomplete tree (null means unreported); missing controls in it do not prove absence. Offscreen/disabled controls are marked. accessibility_error preserves useful pixels when text fails; screenshot_error preserves requested controls when pixels fail, with no coordinate authority. For page reviews prefer browser_snapshot. Never use a tree that contradicts the visible page to choose an element.',
    '',
    'Use a two-step loop: observe and stop to inspect the result, then perform one state-derived action and refresh immediately. Input consumes the preceding observation; interleaving or failure requires a new observation. A failed refresh does not undo the input, so do not repeat an action just because its result image failed.',
    'Native failures retain their code and any known completed_count/failed_index/routes, with a concrete recovery step. Unknown completion stays null. A minimized target needs text-only inspection or activate_window followed by a fresh observation when restoring it is needed. WINDOW_NOT_FOUND needs list_windows and a new target. A capture/focus/stale-state error concerns that operation; it does not mean all tools are disabled or read-only.',
    'click accepts element_index or x/y with optional screenshotId, mouse_button and click_count. set_value uses element_index and value; perform_secondary_action uses element_index and a case-insensitive advertised label such as Raise, Toggle, Expand or Scroll Down. Indexes belong only to the latest accessibility observation for this conversation and window.',
    'Coordinate x/y values are pixels within the selected returned screenshot, starting at its top-left. Use screenshotId from the inspected state, especially for popup images; omit it for the main image. Do not apply DPI, monitor-origin or window-size scaling: the native frame owner converts image pixels to the actual screen. scroll uses scrollX/scrollY wheel deltas (120 per detent, positive Y down); drag uses from_x/from_y/to_x/to_y. All physical input activates and checks the exact target, app identity, frame geometry and related owner before input.',
    'press_key accepts keysym names and + chords such as Control_L+a or Control_L+Shift_L+period. The plus key accepts plus, + or Control_L++. Punctuation follows the target keyboard layout. type_text sends literal text; multiline input uses clipboard paste and requires the existing clipboard-write permission. set_value is preferable for an editable accessibility control. Observe the focused control before typing.',
    'Input already activates its target. activate_window consumes the observation too; refresh before using an index or coordinate. Browser tab/window management chords remain refused: use browser_tabs new for a requested page, or list and attach the exact existing tab, then browser_navigate for URL/history/reload. browser_snapshot reviews existing pages without attach. Native browser-menu controls remain available for an explicitly needed separate window. Address-bar focus (Control_L+l, Alt_L+d) supports authorized navigation in a verified test window. Clipboard tools keep their own permissions.',
    '',
    'JavaScript example: const apps = await sky.list_apps(); nodeRepl.write(apps.map(app => ({id:app.id,name:app.displayName,windows:app.windows})));',
    'Use nodeRepl.write(value) or text(value) for concise text. sky methods return their native arrays/objects or undefined, and throw tool failures. tools.<name> returns the normal MCP envelope with structuredContent.value. Only sky.get_window_state automatically displays images.',
    'This app reuses its bounded exec runtime: variables do not persist across calls, so carry returned Window objects or rehydrate with get_window. No Node, imports, filesystem, network or additional permission layer is installed. Each method still uses this app’s live capability checks, exact caller and local recording. Keep independent reads parallel only when their observations do not conflict; await actions before refreshing.',
    '',
    'Use local file and shell tools only for the user’s requested task.',
    ...userInstructions()
  ].join('\n');
}
