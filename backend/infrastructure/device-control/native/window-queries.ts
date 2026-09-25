import { runHelper } from './transport.js';
import { ComputerError } from './errors.js';
import { exclusive } from './operation-lock.js';
import type { DesktopApp, Rect, WindowInfo } from './types.js';

export async function listWindows(): Promise<{ windows: WindowInfo[]; screen: Rect }> {
  const reply = await runHelper({ op: 'windows' });
  return { windows: (reply['windows'] as WindowInfo[]) ?? [], screen: reply['screen'] as Rect };
}

/** Installed app identities come from the Windows Shell, never model-supplied paths. */
export async function listDesktopApps(opts: { match?: string; limit?: number } = {}): Promise<{ apps: DesktopApp[]; truncated: boolean }> {
  if (process.platform !== 'win32') throw new ComputerError('APPS_UNSUPPORTED: installed app discovery is currently Windows only.');
  return exclusive(async () => {
    const reply = await runHelper({ op: 'apps', match: opts.match ?? '', limit: Math.min(4096, Math.max(1, opts.limit ?? 60)) });
    return { apps: Array.isArray(reply['apps']) ? reply['apps'] : [], truncated: reply['truncated'] === true };
  });
}

export async function focusWindow(id: number): Promise<boolean> {
  const reply = await runHelper({ op: 'focus', id });
  return reply['focused'] === true;
}

export async function activeWindow(): Promise<{ window: WindowInfo | null; screen: Rect }> {
  const reply = await runHelper({ op: 'active' });
  const value = reply['window'];
  const window = value && typeof value === 'object' ? (value as WindowInfo) : null;
  return { window, screen: reply['screen'] as Rect };
}

export async function waitForWindow(opts: {
  title?: string;
  process?: string;
  foreground?: boolean;
  timeoutMs?: number;
}): Promise<WindowInfo> {
  const title = opts.title?.trim().toLowerCase();
  const processName = opts.process?.trim().toLowerCase();
  if (!title && !processName) throw new ComputerError('wait_for_window needs title or process');
  const timeoutMs = Math.min(60_000, Math.max(0, Math.floor(opts.timeoutMs ?? 10_000)));
  const deadline = Date.now() + timeoutMs;
  const matches = (window: WindowInfo): boolean =>
    (!title || window.title.toLowerCase().includes(title)) &&
    (!processName || window.process.toLowerCase().includes(processName));

  for (;;) {
    if (opts.foreground === true) {
      const { window } = await activeWindow();
      if (window && matches(window)) return window;
    } else {
      const { windows } = await listWindows();
      const found = windows.find(matches);
      if (found) return found;
    }
    if (Date.now() >= deadline) {
      throw new ComputerError(
        `WAIT_TIMEOUT: no matching ${opts.foreground === true ? 'foreground ' : ''}window appeared within ${timeoutMs} ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
