import { getConfig, saveConfig } from '../test-context.js';

export const settled = () => new Promise<void>(resolve => setTimeout(resolve, 25));

export const over = (): unknown[] => [
  { kind: 'user_message', time: Date.now(), text: 'x'.repeat(44_000), messageId: 'over-the-line' }
];

export async function withThreshold(tokens: number, run: () => Promise<void>): Promise<void> {
  const base = getConfig();
  await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: tokens } });
  try {
    await run();
  } finally {
    await saveConfig(base);
  }
}
