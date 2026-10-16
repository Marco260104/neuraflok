import { z } from 'zod';

export const pathArg = z.string().min(1).max(4096);
export const lineNumberArg = z.number().int().min(1).max(100_000_000);
export const windowIdArg = z.number().int().min(1).max(4_294_967_295);
export const imageCoordinateArg = z.number().int().min(-100_000).max(100_000);
// Reject unknown coordinate fields instead of letting Zod silently strip them.
export const pointArg = z.object({ x: imageCoordinateArg, y: imageCoordinateArg }).strict();
export const cropArg = z.object({
  x: z.number().int().min(0).max(100_000),
  y: z.number().int().min(0).max(100_000),
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000)
}).strict();
export const mouseButtonArg = z.enum(['left', 'right', 'middle']);
