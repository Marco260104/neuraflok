/** The local tool surfaces and their discovery boundaries. Each surface keeps its complete tool list small enough for clients to inspect before choosing a tool. */

import type { Capabilities } from '../../../../contracts/types.js';
import { desktopAutomationSupported } from '../../settings/platform.js';
import { WINDOWS_COMPUTER_METHODS, WINDOWS_COMPUTER_READ_METHODS, WINDOWS_COMPUTER_INPUT_METHODS } from '../../../../contracts/windows-computer/operation-policy.js';
import { BROWSER_TOOLS, BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../../../../contracts/browser/control-policy.js';

export const SURFACE_IDS = ['core', 'desktop'] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];
const CONNECTOR_BRAND = 'NEURAFLOK';

/** Brand used by the local tool server names, settings and setup guidance. */
export { CONNECTOR_BRAND };

export interface SurfaceDefinition {
  id: SurfaceId;
  /** Stable local MCP server name. */
  serverName: string;
  /** Suggested client-facing name for this local tool surface. */
  connectorName: string;
  /** Exactly what the user should paste as the connector description. This is the single most load-bearing string in the whole design. Before any discovery has happened the model holds the server name and this sentence and nothing else, and it decides from them alone whether to pull this surface's schemas at all. So it is written as vocabulary, not as prose: the words a person would actually use for the work live in here, because a query that misses is indistinguishable to the model from a capability that does not exist. */
  description: string;
  /** Short line for the setup card, in the app's own voice. */
  cardSummary: string;
  /** Whether the app is usable without it. Core is required; Desktop is opt-in and most sessions never want it. */
  required: boolean;
  /** Every tool this surface can ever advertise, in listing order. The authority for tests, for the setup UI's "what you get" list, and for the cross-surface leakage assertions. A tool that appears here and nowhere else is a bug in one direction; a tool registered on a server that does not name it here is a bug in the other. */
  tools: readonly string[];
}

/** Core — the coding loop. Workers are part of the coding loop: - `agents` is one flat tool and is registered only while multi-agent mode is on. Fresh installs enable it; an existing config that keeps it off still pays nothing for it here. A dedicated connector for one conditional schema is pure setup overhead with no discovery benefit. Each surface also exposes JavaScript exec, restricted to that surface's own tools. `find` and the exec pair are mutually exclusive — `find` exists only when command execution is off — so not all declarations are exposed together. */
const CORE: SurfaceDefinition = {
  id: 'core',
  serverName: 'neuraflok-core',
  connectorName: `${CONNECTOR_BRAND} Core`,
  description:
    'Read and edit code and text files on this computer, and run commands in a real terminal. ' +
    'Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, ' +
    'running builds, tests, linters, git, npm and shell commands, continuing long-running or interactive terminal sessions, ' +
    'and saving generated images and files onto this computer. ' +
    'Also displays task plans and — when the user has ' +
    'enabled it — spawns and coordinates worker agents across provider conversations.',
  cardSummary: 'Files, patches and terminal.',
  required: true,
  tools: ['read', 'view_image', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'update_plan', 'agents', 'session_finish', 'exec']
};

/** Desktop — seeing and driving the native desktop. This one earns its boundary twice over. It is gated on permissions the user grants separately and can switch off independently; Windows has the Window2 app/window API, while macOS retains observe/computer. The majority of coding sessions never touch the desktop at all. Folding it into Core would put its weight into every no-query discovery of the coding surface, for a capability most conversations do not want. */
const DESKTOP: SurfaceDefinition = {
  id: 'desktop',
  serverName: 'neuraflok-desktop',
  connectorName: `${CONNECTOR_BRAND} Desktop`,
  description:
    'Control browser tabs in the background and this computer desktop, including its clipboard. ' +
    'Attach existing Chrome/Edge/Brave tabs or open new tabs; inspect DOM refs, page screenshots, JavaScript, console errors and network requests; click, fill forms and navigate without foreground activation. ' +
    'Use for: listing and launching apps, taking background window screenshots, reading what is on screen, listing and finding windows, inspecting buttons, fields and other UI controls, ' +
    'clicking, typing, pressing keys, scrolling and dragging in native applications, ' +
    'and reading the clipboard or copying and pasting text between programs.',
  cardSummary: 'Browser and desktop apps.',
  required: false,
  tools: [...BROWSER_TOOLS, ...WINDOWS_COMPUTER_METHODS, 'read_clipboard', 'write_clipboard', 'observe', 'computer', 'exec']
};

export const SURFACES: Record<SurfaceId, SurfaceDefinition> = { core: CORE, desktop: DESKTOP };

export const SURFACE_LIST: readonly SurfaceDefinition[] = [CORE, DESKTOP];

/** A surface as this install presents it. The connector name carries this computer's suffix (Settings › Setup), read at every call so a saved change reaches the Setup cards, the server instructions and plugin refresh without a restart. `SURFACES` keeps the plain names. */
export function surfaceDefinition(id: SurfaceId): SurfaceDefinition {
  return SURFACES[id];
}

/** Platform/capability projection used by setup; each registrar enforces the same split. */
export function desktopToolNames(caps: Capabilities, platform: NodeJS.Platform = process.platform): string[] {
  const browser = [...(caps.screen ? BROWSER_READ_TOOLS : []), ...(caps.control ? BROWSER_WRITE_TOOLS : [])];
  if (!desktopAutomationSupported(platform)) return browser;
  if (platform !== 'win32') return [...browser, ...(caps.screen ? ['observe'] : []), ...(caps.control || caps.clipboardRead || caps.clipboardWrite ? ['computer'] : [])];
  return [
    ...browser,
    ...(caps.screen ? WINDOWS_COMPUTER_READ_METHODS : []),
    ...(caps.control ? WINDOWS_COMPUTER_INPUT_METHODS : []),
    ...(caps.clipboardRead ? ['read_clipboard'] : []),
    ...(caps.clipboardWrite ? ['write_clipboard'] : [])
  ];
}

/** Whether a surface has useful tools under the current permissions and host capabilities. */
export function surfaceIsUseful(
  id: SurfaceId,
  caps: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): boolean {
  // Clipboard counts: it is reached through `computer`, so granting only the clipboard still gives this surface something real to advertise.
  if (id === 'desktop') {
    return (
      caps.screen || caps.control || (desktopAutomationSupported(platform, release) && (caps.clipboardRead || caps.clipboardWrite))
    );
  }
  return true;
}
