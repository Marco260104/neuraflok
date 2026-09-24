import { z } from 'zod';

export const browserPreferencesSchema = z.object({
  overwrite: z.boolean(),
  durations: z.boolean()
}).strict();

export const browserPreferencePatchSchema = browserPreferencesSchema.partial().strict();

export type BrowserPreferences = z.infer<typeof browserPreferencesSchema>;
