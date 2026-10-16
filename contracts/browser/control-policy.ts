const READ_ONLY_TOOLS = [
  'browser_tabs',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
  'browser_network'
] as const;

const STATE_CHANGING_TOOLS = [
  'browser_navigate',
  'browser_action',
  'browser_evaluate'
] as const;

const TAB_ACTIONS_THAT_WRITE = new Set(['new', 'close']);

export const BROWSER_READ_TOOLS = Object.freeze(READ_ONLY_TOOLS);
export const BROWSER_WRITE_TOOLS = Object.freeze(STATE_CHANGING_TOOLS);
export const BROWSER_TOOLS = Object.freeze([...READ_ONLY_TOOLS, ...STATE_CHANGING_TOOLS]);

export type BrowserTool = (typeof BROWSER_TOOLS)[number];

export const BROWSER_LIMITS = {
  clients: 8,
  pending: 32,
  timeoutMs: 25_000,
  presenceMs: 75_000,
  textChars: 24_000,
  resultBytes: 1_800_000,
  imageBytes: 1_200_000
} as const;

export interface BrowserCommand {
  id: string;
  epoch: string;
  owner: string;
  // Aliases must have been verified against the request owner in the main process.
  ownerAliases?: string[];
  conversationId: string | null;
  tool: BrowserTool;
  args: Record<string, unknown>;
  expiresAt: number;
}

export interface BrowserResult {
  value?: unknown;
  image?: { data: string; mimeType: 'image/jpeg' | 'image/png' };
  error?: string;
}

export function browserToolWrites(tool: BrowserTool, args: Record<string, unknown>): boolean {
  if (STATE_CHANGING_TOOLS.some(candidate => candidate === tool)) return true;
  return tool === 'browser_tabs' && TAB_ACTIONS_THAT_WRITE.has(String(args.action));
}
