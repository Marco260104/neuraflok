import { toolDeclaration } from '../declaration-cache.js';
import { actAndCapture, type Action, type VerificationSpec } from '../../../device-control/native/index.js';
import { logInfo } from '../../../settings/logger.js';
import { noteDetail } from '../call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from '../kernel.js';
import { browserChordRefusal } from './browser-safety.js';
import { computerInputSchema } from './computer-schema.js';
import { desktopImageResult, MAX_CLIPBOARD_LINE_CHARS, MAX_CLIPBOARD_OUTPUT_CHARS } from './shared.js';

/** Register ordered desktop actions with separate live permissions for input and clipboard access. */
export function registerMacOSComputerTool(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;

  if (exposedCaps.control || exposedCaps.clipboardRead || exposedCaps.clipboardWrite) {
    reg.register(
      'computer',
      toolDeclaration('computer', () => ({
        title: 'Control mouse and keyboard',
        description:
          'Run ordered desktop actions. Prefer refs from observe; pixels require frameId and target geometry is rechecked. ' +
          'verify waits for a postcondition. Capture and clipboard steps stay in the batch.',
        inputSchema: computerInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      })),
      async ({ actions, frameId, verify, captureAfter, captureWindow, captureFull, captureMaxWidth, captureCrop }) =>
        guard('computer', async () => {
          // Not reg.guarded: this tool covers two permissions. Pointer and keyboard steps need "control", the clipboard steps need their own, and one blanket refusal would hide which of them the user actually has to switch on.
          if (!caps.control && actions.some((a) => a.type !== 'wait' && !a.type.endsWith('_clipboard'))) {
            return fail(
              'TOOL_DISABLED: mouse and keyboard control is disabled by the current NEURAFLOK permissions. ' +
                'Ask the user to enable "Control mouse and keyboard" in the app, then retry.'
            );
          }
          const parsed: Action[] = [];
          for (const a of actions) {
            switch (a.type) {
              case 'click_ref':
                parsed.push({ type: 'click_ref', ref: a.ref });
                break;
              case 'set_value':
                parsed.push({ type: 'set_value', ref: a.ref, text: a.text });
                break;
              case 'click':
              case 'double_click':
                parsed.push({ type: a.type, x: a.x, y: a.y, button: a.button });
                break;
              case 'move':
                parsed.push({ type: 'move', x: a.x, y: a.y });
                break;
              case 'scroll':
                parsed.push({ type: 'scroll', x: a.x, y: a.y, scroll_x: a.scroll_x, scroll_y: a.scroll_y });
                break;
              case 'drag':
                parsed.push({ type: 'drag', path: a.path, button: a.button });
                break;
              case 'type':
                parsed.push({ type: 'type', text: a.text });
                break;
              case 'keypress':
                parsed.push({ type: 'keypress', keys: a.keys });
                break;
              case 'focus':
                parsed.push({ type: 'focus', window: a.window });
                break;
              case 'wait':
                parsed.push({ type: 'wait', ms: a.ms });
                break;
              case 'read_clipboard':
                // Keep the schema stable and enforce the clipboard permission at runtime.
                if (!caps.clipboardRead) {
                  return fail('TOOL_DISABLED: read_clipboard needs the Read the clipboard permission.');
                }
                parsed.push({ type: 'read_clipboard' });
                break;
              case 'write_clipboard':
                if (!caps.clipboardWrite) {
                  return fail('TOOL_DISABLED: write_clipboard needs the Replace clipboard text permission.');
                }
                parsed.push({ type: 'write_clipboard', text: a.text });
                break;
            }
          }
          const chordRefusal = await browserChordRefusal(parsed);
          if (chordRefusal) return fail(chordRefusal);
          logInfo(`tool computer ${parsed.map((a) => a.type).join(', ')}`);
          noteDetail(parsed.map((a) => a.type).join(', '));
          const verifyCapture = verify?.capture === 'always' || verify?.capture === 'on_change';
          const wantsCapture = captureAfter === true || verifyCapture;
          if ((verify || wantsCapture) && !caps.screen) {
            return fail('TOOL_DISABLED: verification and result capture need the See the screen permission.');
          }
          const parsedVerify: VerificationSpec | undefined = verify
            ? verify.until === 'foreground'
              ? { until: 'foreground', window: verify.window!, timeoutMs: verify.timeout_ms }
              : verify.until === 'window_exists' || verify.until === 'window_closed'
                ? { until: verify.until, match: verify.match!, timeoutMs: verify.timeout_ms }
                : {
                    until: verify.until,
                    window: verify.window,
                    match: verify.match!,
                    role: verify.role,
                    timeoutMs: verify.timeout_ms
                  }
            : undefined;
          // One lock, one operation: the picture that verifies these actions must be taken before anyone else can touch the desktop.
          const result = await actAndCapture(parsed, {
            frameId,
            verify: parsedVerify,
            capture:
              wantsCapture
                ? {
                    window: captureWindow,
                    full: captureFull,
                    maxWidth: captureMaxWidth,
                    crop: captureCrop,
                    preferActiveWindow: ctx.privacyScreenshots
                  }
                : undefined
          });
          const cursor = result.cursor;
          const pointer = cursor
            ? cursor.image
              ? `Pointer image: ${cursor.image.x},${cursor.image.y} (frame ${cursor.frameId}, ${cursor.imageSize?.width}x${cursor.imageSize?.height}); desktop: ${cursor.screen.x},${cursor.screen.y}.`
              : `Pointer desktop: ${cursor.screen.x},${cursor.screen.y}. No screenshot frame is active.`
            : 'Pointer position was not queried because this batch used only local wait/clipboard actions.';
          // Clipboard reads are the one action that returns something, so they are quoted back in order rather than folded into the "Done:" line.
          const clipboardLines: string[] = [];
          let clipboardBudget = MAX_CLIPBOARD_OUTPUT_CHARS;
          for (const [index, text] of result.clipboard.entries()) {
            if (clipboardBudget <= 0) {
              clipboardLines.push(`… ${result.clipboard.length - index} more clipboard read(s) omitted by the output cap`);
              break;
            }
            const prefixText = `Clipboard read ${index + 1}: `;
            const rendered = text === '' ? '(empty)' : JSON.stringify(text);
            const payloadCap = Math.max(0, Math.min(MAX_CLIPBOARD_LINE_CHARS, clipboardBudget - prefixText.length - 80));
            const payload =
              rendered.length <= payloadCap
                ? rendered
                : `${rendered.slice(0, payloadCap)}… [truncated; ${text.length} chars original]`;
            const line = `${prefixText}${payload}`.slice(0, clipboardBudget);
            clipboardLines.push(line);
            clipboardBudget -= line.length + 1;
          }
          const clipboard = clipboardLines.join('\n');
          const routeSummary = [...new Set(result.routes)].join('+') || 'local';
          const verified = result.verification
            ? `\nVerified ${result.verification.until} in ${result.verification.elapsedMs} ms: ${result.verification.detail}.`
            : '';
          const done = `Done ${result.completedCount}/${parsed.length} via ${routeSummary}: ${parsed.map((a) => a.type).join(', ')}. ${pointer}${clipboard ? `\n${clipboard}` : ''}${verified}`;
          const shot = result.screenshot;
          if (shot) {
            return desktopImageResult(
              `${done}\nCaptured frame ${shot.frameId}, ${shot.width}x${shot.height}. Use this frame for the next coordinates.`,
              shot.data
            );
          }
          return ok(done);
        })
    );
  }
}
