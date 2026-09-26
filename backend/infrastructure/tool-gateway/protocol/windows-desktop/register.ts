import { z } from 'zod';
import { act, ComputerError } from '../../../device-control/native/index.js';
import { WINDOWS_API_METHODS, WINDOWS_API_SCHEMAS } from '../../../device-control/native/windows-api.js';
import { noteCount } from '../call-context.js';
import { fail, type SurfaceRegistrar } from '../kernel.js';
import { WINDOWS_COMPUTER_READ_METHODS } from '../../../../../contracts/windows-computer/operation-policy.js';
import { toolDeclaration } from '../declaration-cache.js';
import { apiForCaller } from './caller-context.js';
import { nativeFailure, refuseBrowserChord } from './failure-guidance.js';
import { desktopResult } from './result.js';

const READ_METHODS = new Set<string>(WINDOWS_COMPUTER_READ_METHODS);

const DESCRIPTIONS: Record<string, string> = {
  list_windows: 'List Windows app/window objects with current state (foreground, open or minimized). Choose one returned window before input. A minimized window needs text-only inspection or activation before a screenshot.',
  get_window: 'Resolve a returned window by id and optional app identity.',
  list_apps: 'List installed and running Windows apps with their exact owned windows.',
  launch_app: 'Launch an observed app id or explicit .exe path/name, without command arguments. Observe its window afterward.',
  get_window_state: 'Observe without activation. Images default on; include_text adds controls. query matches name/automation id; role filters type; max_elements limits matches. Search implies text. include_screenshot:false skips pixels. Use returned image coordinates.',
  click: 'Click image-pixel x/y in the selected screenshot or current element_index; supports mouse_button and click_count. Omit screenshotId for the main image. Refresh state after input.',
  press_key: 'Press a keysym-style key or chord (Control_L+s) in the exact window. The plus key accepts plus, + or Control_L++. Automatically activates its target.',
  type_text: 'Type literal text in the exact window. Multiline text uses clipboard paste and the existing clipboard-write permission.',
  scroll: 'Scroll by horizontal/vertical wheel deltas at image-pixel x/y in the selected screenshot; positive Y scrolls down.',
  set_value: 'Replace the value of an indexed editable control from the latest accessibility state.',
  drag: 'Drag smoothly between two image-pixel coordinates in the selected screenshot, then release.',
  perform_secondary_action: 'Perform an advertised accessibility action on an element_index; action labels are case-insensitive.',
  activate_window: 'Activate an exact returned window. Input methods already activate their target automatically. This consumes prior observation indexes and coordinates; get_window_state again before using them.'
};

export function registerWindowsDesktopTools(reg: SurfaceRegistrar): void {
  for (const method of WINDOWS_API_METHODS) {
    const read = READ_METHODS.has(method);
    const capability = read ? 'screen' : 'control';
    if (!reg.exposedCaps[capability]) continue;
    reg.register(method, toolDeclaration(method, () => ({
      description: DESCRIPTIONS[method]!,
      inputSchema: WINDOWS_API_SCHEMAS[method],
      annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: read, openWorldHint: true }
    }), 'windows'), input => reg.guarded(capability, method, async () => {
      if (method === 'type_text' && 'text' in input && /[\r\n]/.test(String(input.text)) && !reg.caps.clipboardWrite) {
        return fail('TOOL_DISABLED: multiline text needs the existing Replace clipboard text permission. No input ran.');
      }
      if (method === 'press_key') {
        const keys = input as { key: string; window: { id: number } };
        try {
          const refusal = await refuseBrowserChord(keys.key, keys.window);
          if (refusal) return fail(refusal);
        } catch (error) {
          const failure = nativeFailure(error);
          if (failure) return failure;
          throw error;
        }
      }
      const api = apiForCaller(method);
      const invoke = api[method] as (args: unknown) => Promise<unknown>;
      let value: unknown;
      try { value = await invoke(input); }
      catch (error) {
        const failure = nativeFailure(error);
        if (failure) return failure;
        throw error;
      }
      if (Array.isArray(value)) noteCount(value.length);
      return desktopResult(method, value);
    }));
  }

  if (reg.exposedCaps.clipboardRead) reg.register('read_clipboard', toolDeclaration('read_clipboard', () => ({
    description: 'Read this computer’s clipboard text.', inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  })), () => reg.guarded('clipboardRead', 'read_clipboard', async () => {
    const value = (await act([{ type: 'read_clipboard' }])).clipboard[0] ?? '';
    if (value.length > 64_000) throw new ComputerError('CLIPBOARD_TOO_LARGE: clipboard text exceeds the response limit.');
    return desktopResult('read_clipboard', value);
  }));
  if (reg.exposedCaps.clipboardWrite) reg.register('write_clipboard', toolDeclaration('write_clipboard', () => ({
    description: 'Replace this computer’s clipboard text.', inputSchema: z.object({ text: z.string().max(100_000) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  })), input => reg.guarded('clipboardWrite', 'write_clipboard', async () => {
    await act([{ type: 'write_clipboard', text: input.text }]);
    return { content: [{ type: 'text', text: 'Clipboard text replaced.' }], structuredContent: { value: null } };
  }));
}
