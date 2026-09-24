import { WINDOWS_COMPUTER_READ_METHODS, WINDOWS_COMPUTER_INPUT_METHODS } from '../windows-computer/operation-policy.js';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../browser/control-policy.js';
import type { PlatformFamily } from '../settings.js';
// Each entry maps to one user-facing permission and its available local tool operations.

export const CAPABILITIES = [
  'browse',
  'search',
  'read',
  'metadata',
  'create',
  'edit',
  'move',
  'deleteFile',
  'command',
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Model-facing Desktop permissions, enabled only on hosts with a native backend. */
export const DESKTOP_CAPABILITIES: readonly Capability[] = [
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
];

/** Capabilities that change something outside this app — files on disk, code that runs, or the desktop itself. Blocked outright by read-only mode. `screen` is not here: looking at the screen changes nothing. `control` is, because driving the mouse and keyboard can do anything the user can. */
export const WRITE_CAPABILITIES: readonly Capability[] = [
  'create',
  'edit',
  'move',
  'deleteFile',
  'command',
  'control',
  'clipboardWrite'
];

export type Capabilities = Record<Capability, boolean>;

export const DEFAULT_CAPABILITIES: Capabilities = {
  browse: true,
  search: true,
  read: true,
  metadata: true,
  create: false,
  edit: false,
  move: false,
  deleteFile: false,
  command: false,
  screen: false,
  control: false,
  clipboardRead: false,
  clipboardWrite: false
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  browse: 'Browse folders',
  search: 'Search files',
  read: 'Read files',
  metadata: 'File metadata',
  create: 'Create files',
  edit: 'Edit files',
  move: 'Move / rename',
  deleteFile: 'Delete files',
  command: 'Run commands',
  screen: 'See the screen',
  control: 'Control mouse and keyboard',
  clipboardRead: 'Read clipboard',
  clipboardWrite: 'Write clipboard'
};

/** One short line per capability, shown under its checkbox when the group is expanded. A clause, not a paragraph. Which MCP tools a permission actually turns on is a separate fact and is listed separately — see capabilityTools — because that list is the part that goes stale when the tool surface is consolidated, and a sentence with the tool name buried in it is a sentence nobody rewrites when the tool is renamed. */
export const CAPABILITY_DETAILS: Record<Capability, string> = {
  browse: 'List what is inside an approved folder.',
  search: 'Find files by name or glob, and text inside them.',
  read: 'Read text in ranges, and open local images into vision.',
  metadata: 'Size, dates and line count, without the contents.',
  create: 'Add new files, and the folders they need.',
  edit: 'Exact edits, applied atomically across files.',
  move: 'Move or rename, both ends inside approved folders.',
  deleteFile: 'Permanent — there is no Recycle Bin.',
  command: 'Run anything as you. NOT limited to approved folders.',
  screen: 'Browser tabs, DOM, screenshots, console and network; native windows where supported.',
  control: 'Browser navigation, input and page JavaScript; native mouse and keyboard where supported.',
  clipboardRead: 'Read the current clipboard text.',
  clipboardWrite: 'Replace the clipboard without focus or keystrokes.'
};

/** The MCP tools each permission actually exposes. Kept beside the capability list rather than written into the prose above, so the tool selector shows what this build really registers. `read` carries `view_image` as well as `read`; `find` exists only where running commands is switched off, which is why it is marked rather than listed flatly (see SurfaceRegistrar.findExposed). */
const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  browse: ['read'],
  search: ['read', 'find'],
  read: ['read', 'view_image'],
  metadata: ['read'],
  create: ['apply_patch'],
  edit: ['apply_patch'],
  move: ['apply_patch'],
  deleteFile: ['apply_patch'],
  command: ['exec_command', 'write_stdin'],
  screen: ['observe'],
  control: ['computer'],
  clipboardRead: ['computer'],
  clipboardWrite: ['computer']
};

/** Settings use the same Windows method lists as registration, with explicit host identity. */
export function capabilityTools(capability: Capability, platform?: PlatformFamily): readonly string[] {
  const browser = capability === 'screen' ? BROWSER_READ_TOOLS : capability === 'control' ? BROWSER_WRITE_TOOLS : [];
  if (!DESKTOP_CAPABILITIES.includes(capability)) return CAPABILITY_TOOLS[capability];
  if (platform === 'macos') return [...browser, ...CAPABILITY_TOOLS[capability]];
  if (platform !== 'windows') return browser;
  switch (capability) {
    case 'screen': return [...browser, ...WINDOWS_COMPUTER_READ_METHODS];
    case 'control': return [...browser, ...WINDOWS_COMPUTER_INPUT_METHODS];
    case 'clipboardRead': return ['read_clipboard'];
    case 'clipboardWrite': return ['write_clipboard'];
    default: return [];
  }
}

