import { z } from 'zod';

export const CODE_MODE_LIMITS = Object.freeze({
  codeChars: 64_000,
  cpuMs: 2_000,
  wallMs: 60_000,
  memoryBytes: 32 * 1024 * 1024,
  calls: 32,
  concurrentCalls: 8,
  argumentBytes: 1024 * 1024,
  resultBytes: 12 * 1024 * 1024,
  totalResultBytes: 32 * 1024 * 1024,
  outputBytes: 12 * 1024 * 1024,
  outputItems: 32,
  textBytes: 40_000,
  images: 4,
  activeRuns: 4
});

export const codeModeSchema = z.object({
  code: z.string().min(1).max(CODE_MODE_LIMITS.codeChars)
    .describe('Raw JavaScript source with top-level await. Emit results with text(...) or image(...).')
}).strict();

export type CodeModeTool = { name: string; description: string };
export type CodeModeOptions = { windowsDesktop?: boolean };
