import { z } from 'zod';
import { toolDeclaration } from '../declaration-cache.js';
import {
  ComputerError,
  DEFAULT_SCREENSHOT_WIDTH,
  MAX_SCREENSHOT_WIDTH,
  activeWindow,
  findUi,
  getWindowState,
  listWindows,
  screenshot,
  waitForWindow
} from '../../../device-control/native/index.js';
import { logInfo } from '../../../settings/logger.js';
import { noteCount } from '../call-context.js';
import { windowIdArg } from '../tool-arguments.js';
import { ok, type SurfaceRegistrar } from '../kernel.js';
import { desktopImageResult, describeWindow, prefix } from './shared.js';

const DEFAULT_WINDOW_RESULTS = 60;
const MAX_WINDOW_RESULTS = 100;

/** Register read-only native desktop observations behind the screen permission. */
export function registerMacOSObserveTool(reg: SurfaceRegistrar): void {
  const { exposedCaps } = reg;

  if (exposedCaps.screen) {
    reg.register(
      'observe',
      toolDeclaration('observe', () => ({
        title: 'Look at the desktop',
        description:
          'Look at the desktop without touching it. With no arguments, returns the foreground window, its picture and snapshot-scoped UI controls. ' +
          'what=windows lists windows; what=window inspects one; what=ui returns controls; wait_for waits for a title. ' +
          'Pass refs to computer click_ref/set_value and screenshot frameId with pixel coordinates. ' +
          'Window capture never focuses; a labeled visible-screen fallback may be occluded.',
        inputSchema: z
          .object({
            what: z
              .enum(['active', 'windows', 'window', 'ui'])
              .optional()
              .describe('Default active: the foreground window, its screenshot and its controls.'),
            window: windowIdArg.optional().describe('Window id for what=window or what=ui.'),
            match: z.string().max(300).optional().describe('Filter: title/process for windows, control name/role for ui.'),
            wait_for: z.string().min(1).max(300).optional().describe('Wait until a window with this title substring exists.'),
            timeout_ms: z.number().int().min(0).max(60_000).optional().describe('With wait_for. Default 10000.'),
            screenshot: z.boolean().optional().describe('Include a picture. Default true for active and window.'),
            max_width: z
              .number()
              .int()
              .min(320)
              .max(MAX_SCREENSHOT_WIDTH)
              .optional()
              .describe(`Screenshot width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
            max_elements: z
              .number()
              .int()
              .min(1)
              .max(MAX_WINDOW_RESULTS)
              .optional()
              .describe('Maximum controls or windows returned. Default 60.')
          })
          .superRefine((input, ctx) => {
            const what = input.wait_for ? (input.what ?? 'window') : (input.what ?? 'active');
            if (input.timeout_ms !== undefined && input.wait_for === undefined) {
              ctx.addIssue({ code: 'custom', path: ['timeout_ms'], message: 'timeout_ms requires wait_for' });
            }
            if (input.window !== undefined && input.wait_for !== undefined) {
              ctx.addIssue({ code: 'custom', path: ['window'], message: 'window cannot be combined with wait_for, which selects the window' });
            } else if (input.window !== undefined && what !== 'window' && what !== 'ui') {
              ctx.addIssue({ code: 'custom', path: ['window'], message: `window is not used with what=${what}` });
            }
            if (input.match !== undefined && what !== 'windows' && what !== 'ui') {
              ctx.addIssue({ code: 'custom', path: ['match'], message: 'match is only used with what=windows or what=ui' });
            }
            if ((what === 'windows' || what === 'ui') && input.screenshot === true) {
              ctx.addIssue({ code: 'custom', path: ['screenshot'], message: `screenshot=true is not used with what=${what}` });
            }
            const capturesImage = what !== 'windows' && what !== 'ui' && input.screenshot !== false;
            if (input.max_width !== undefined && !capturesImage) {
              ctx.addIssue({ code: 'custom', path: ['max_width'], message: 'max_width requires a screenshot-producing observation' });
            }
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      })),
      async (input) =>
        reg.guarded('screen', 'observe', async () => {
          // wait_for happens first and then answers the ordinary question about whatever it found, so "wait for the installer, then look at it" is one call rather than a wait followed by a second call that races the window closing again.
          let target = input.window;
          let waited: string | null = null;
          if (input.wait_for) {
            const found = await waitForWindow({
              title: input.wait_for,
              foreground: false,
              timeoutMs: input.timeout_ms
            });
            target = found.id;
            waited = `Found "${found.title}" (${found.process}) as window ${found.id}.`;
          }

          const what = input.wait_for ? (input.what ?? 'window') : (input.what ?? 'active');

          if (what === 'windows') {
            const { windows, screen } = await listWindows();
            const needle = input.match?.toLowerCase() ?? null;
            const matching = needle
              ? windows.filter(
                  (w) => w.title.toLowerCase().includes(needle) || w.process.toLowerCase().includes(needle)
                )
              : windows;
            const limit = Math.min(MAX_WINDOW_RESULTS, Math.max(1, Math.floor(input.max_elements ?? DEFAULT_WINDOW_RESULTS)));
            const shown = matching.slice(0, limit);
            noteCount(shown.length);
            logInfo(`tool observe windows (${shown.length}/${matching.length} matched, ${windows.length} total)`);
            if (shown.length === 0) return ok(prefix(waited, 'No visible windows match.'));
            const lines = shown.map(
              (w) => `${w.id}  ${w.process}  ${w.x},${w.y}  ${w.width}x${w.height}  ${w.state}  ${w.title}`
            );
            if (shown.length < matching.length) {
              lines.push(`… showing ${shown.length} of ${matching.length} matching windows; narrow match or raise max_elements`);
            }
            return ok(
              prefix(
                waited,
                `Desktop ${screen.width}x${screen.height}\nid  program  position  size  state  title\n${lines.join('\n')}`
              )
            );
          }

          if (what === 'ui' && input.match) {
            const result = await findUi({ window: target, query: input.match, maxResults: input.max_elements });
            noteCount(result.elements.length);
            if (result.elements.length === 0) {
              return ok(prefix(waited, `No controls in window ${result.window} match "${input.match}".`));
            }
            const lines = result.elements.map((element, index) => {
              const desktop = `${element.bounds.x},${element.bounds.y} ${element.bounds.width}x${element.bounds.height}`;
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const id = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              return `${index + 1}. ${element.ref} ${element.role} ${JSON.stringify(element.name)}${id} desktop=${desktop}${image}${flags}`;
            });
            return ok(prefix(waited, `window: ${result.window}\nsnapshot: ${result.snapshotId}\n${lines.join('\n')}`));
          }

          // A bare "what is on screen right now" with no window at all: cheapest possible answer, and the only one that still works when there is no foreground window.
          if (what === 'active' && target === undefined && input.screenshot === false) {
            const { window, screen } = await activeWindow();
            if (!window) return ok(prefix(waited, `Desktop ${screen.width}x${screen.height}\nNo foreground window.`));
            return ok(prefix(waited, describeWindow(window)));
          }

          const wantsShot = what === 'ui' ? false : input.screenshot !== false;
          let state: Awaited<ReturnType<typeof getWindowState>>;
          try {
            state = await getWindowState({
              window: target,
              maxWidth: input.max_width,
              maxElements: input.max_elements,
              includeScreenshot: wantsShot,
              includeUi: true
            });
          } catch (err) {
            // "There is no foreground window" is a real native desktop state — a locked screen, a shell restart, everything minimised — and it is not a reason to refuse to look. Fall back to the monitor, which is the honest answer.
            if (
              target !== undefined ||
              !(err instanceof ComputerError) ||
              !err.message.startsWith('WINDOW_NOT_FOUND:')
            ) {
              throw err;
            }
            const shot = await screenshot({ maxWidth: input.max_width });
            return desktopImageResult(
              prefix(
                waited,
                `No foreground window, so this is the whole primary monitor.\nframe: ${shot.frameId}  ${shot.width}x${shot.height} — pass frameId ${shot.frameId} with any coordinates you read off it`
              ),
              shot.data
            );
          }
          noteCount(state.elements.length);
          logInfo(`tool observe ${what} window=${state.window.id} (${state.elements.length} controls)`);

          const lines = [
            `window: ${state.window.id}  ${state.window.process}  ${state.window.state}  ${state.window.title}`,
            `bounds: ${state.window.x},${state.window.y} ${state.window.width}x${state.window.height}`
          ];
          if (state.snapshotId !== null) lines.push(`snapshot: ${state.snapshotId}`);
          if (state.screenshot) {
            lines.push(
              `frame: ${state.screenshot.frameId}  ${state.screenshot.width}x${state.screenshot.height} — pass frameId ${state.screenshot.frameId} with any coordinates you read off it`
            );
            if (state.screenshot.captureMode === 'screen_fallback') {
              lines.push(
                'note: background window capture was unavailable, so these are visible screen pixels and may show something covering the target.'
              );
            }
          }
          if (state.elements.length > 0) {
            lines.push('controls:');
            for (const element of state.elements) {
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const automation = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              lines.push(`${element.ref}  ${element.role} ${JSON.stringify(element.name)}${automation}${image}${flags}`);
            }
          } else if (state.uiUnavailable) {
            lines.push(`controls: unavailable (${state.uiUnavailable.code}) — ${state.uiUnavailable.message}`);
          } else {
            lines.push('controls: none exposed by the platform accessibility API');
          }

          const text = prefix(waited, lines.join('\n'));
          if (!state.screenshot) return ok(text);
          return desktopImageResult(text, state.screenshot.data);
        })
    );
  }
}
