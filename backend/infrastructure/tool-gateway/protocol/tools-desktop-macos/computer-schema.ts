import { z } from 'zod';
import { DEFAULT_SCREENSHOT_WIDTH, MAX_SCREENSHOT_WIDTH } from '../../../device-control/native/index.js';
import { cropArg, imageCoordinateArg, mouseButtonArg, pointArg, windowIdArg } from '../tool-arguments.js';

const computerActionArg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click_ref'), ref: z.string().min(1).max(64) }).strict().describe('Click a control by ref from observe.'),
  z
    .object({ type: z.literal('set_value'), ref: z.string().min(1).max(64), text: z.string().max(20_000) })
    .strict()
    .describe('Set a text control’s value directly by ref.'),
  z
    .object({ type: z.literal('click'), x: imageCoordinateArg, y: imageCoordinateArg, button: mouseButtonArg.optional() })
    .strict()
    .describe('Click at image coordinates.'),
  z
    .object({
      type: z.literal('double_click'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      button: mouseButtonArg.optional()
    })
    .strict()
    .describe('Double-click at image coordinates.'),
  z.object({ type: z.literal('move'), x: imageCoordinateArg, y: imageCoordinateArg }).strict().describe('Move the pointer.'),
  z
    .object({ type: z.literal('drag'), path: z.array(pointArg).min(2).max(64), button: mouseButtonArg.optional() })
    .strict()
    .describe('Press, follow the path, release.'),
  z
    .object({
      type: z.literal('scroll'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      scroll_x: z.number().int().min(-10_000).max(10_000).optional(),
      scroll_y: z.number().int().min(-10_000).max(10_000).optional()
    })
    .strict()
    .describe('Scroll at a point.'),
  z.object({ type: z.literal('type'), text: z.string().max(4000) }).strict().describe('Type text into whatever has focus.'),
  z
    .object({ type: z.literal('keypress'), keys: z.array(z.string().max(20)).min(1).max(6) })
    .strict()
    .describe(
      'Press keys together, e.g. ["ctrl","s"] (Windows) or ["command","s"] (macOS). Browser tab/window management chords are refused; address-bar focus chords and set_value support authorized navigation.'
    ),
  z.object({ type: z.literal('focus'), window: windowIdArg }).strict().describe('Bring a window to the front.'),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000).optional() }).strict().describe('Pause.'),
  z.object({ type: z.literal('read_clipboard') }).strict().describe('Return the clipboard text.'),
  z
    .object({ type: z.literal('write_clipboard'), text: z.string().max(100_000) })
    .strict()
    .describe('Replace the clipboard text; paste with command+v on macOS or ctrl+v on Windows/Linux.')
]);

const verificationArg = z
  .object({
    until: z.enum(['foreground', 'window_exists', 'window_closed', 'ui_appears', 'ui_disappears']),
    window: windowIdArg.optional(),
    match: z.string().min(1).max(300).optional(),
    role: z.string().min(1).max(100).optional(),
    timeout_ms: z.number().int().min(0).max(10_000).optional(),
    capture: z.enum(['on_change', 'always', 'never']).optional()
  })
  .strict();

export const computerInputSchema = z
          .object({
            actions: z.array(computerActionArg).min(1).max(20),
            frameId: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe('Required for coordinate actions or captureCrop.'),
            verify: verificationArg.optional(),
            captureAfter: z.boolean().optional().describe('Return a fresh screenshot after the actions. Default false.'),
            captureWindow: windowIdArg.optional().describe('Result capture: this window.'),
            captureFull: z.boolean().optional().describe('Result capture: all monitors.'),
            captureMaxWidth: z
              .number()
              .int()
              .min(320)
              .max(MAX_SCREENSHOT_WIDTH)
              .optional()
              .describe(`Result capture width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
            captureCrop: cropArg.optional().describe('Result crop in the input frame.')
          })
          .superRefine((input, ctx) => {
            if (input.verify) {
              const needsWindow = input.verify.until === 'foreground';
              const needsMatch = input.verify.until !== 'foreground';
              const isUi = input.verify.until === 'ui_appears' || input.verify.until === 'ui_disappears';
              if (needsWindow && input.verify.window === undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'window'], message: 'foreground verification requires window' });
              }
              if (needsMatch && input.verify.match === undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'match'], message: `${input.verify.until} verification requires match` });
              }
              if (!isUi && input.verify.role !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'role'], message: 'role is only used by UI verification' });
              }
              if (!isUi && input.verify.until !== 'foreground' && input.verify.window !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'window'], message: 'window is only used by foreground or UI verification' });
              }
              if (input.verify.until === 'foreground' && input.verify.match !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'match'], message: 'match is not used by foreground verification' });
              }
            }
            const verifyCapture = input.verify?.capture === 'always' || input.verify?.capture === 'on_change';
            const willCapture = input.captureAfter === true || verifyCapture;
            const captureFields = ['captureWindow', 'captureFull', 'captureMaxWidth', 'captureCrop'] as const;
            if (!willCapture) {
              for (const field of captureFields) {
                if (input[field] !== undefined) {
                  ctx.addIssue({ code: 'custom', path: [field], message: `${field} requires captureAfter=true or verify.capture` });
                }
              }
              return;
            }
            if (input.captureCrop !== undefined && input.frameId === undefined) {
              ctx.addIssue({ code: 'custom', path: ['frameId'], message: 'frameId is required with captureCrop' });
            }
            const targetCount = Number(input.captureWindow !== undefined) + Number(input.captureFull === true) + Number(input.captureCrop !== undefined);
            if (targetCount > 1) {
              ctx.addIssue({
                code: 'custom',
                path: ['captureAfter'],
                message: 'captureWindow, captureFull=true, and captureCrop are mutually exclusive capture targets'
              });
            }
          })
          .strict();
