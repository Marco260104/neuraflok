import { activeWindow, listWindows } from './window-queries.js';
import { ComputerError } from './errors.js';
import { findUiLocked } from './observations.js';
import type { VerificationResult, VerificationSpec } from './types.js';

export async function verifyDesktopLocked(spec: VerificationSpec): Promise<VerificationResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(10_000, Math.max(0, Math.floor(spec.timeoutMs ?? 2_000)));
  const deadline = startedAt + timeoutMs;
  const needle = 'match' in spec ? spec.match.trim().toLowerCase() : '';
  for (;;) {
    if (spec.until === 'foreground') {
      const current = (await activeWindow()).window;
      if (current?.id === spec.window) {
        return {
          until: spec.until,
          elapsedMs: Date.now() - startedAt,
          detail: `window ${spec.window} is foreground`,
          snapshotId: null
        };
      }
    } else if (spec.until === 'window_exists' || spec.until === 'window_closed') {
      const { windows } = await listWindows();
      const found = windows.find(window =>
        window.title.toLowerCase().includes(needle) || window.process.toLowerCase().includes(needle)
      );
      if ((spec.until === 'window_exists' && found) || (spec.until === 'window_closed' && !found)) {
        return {
          until: spec.until,
          elapsedMs: Date.now() - startedAt,
          detail: found ? `found window ${found.id} ${JSON.stringify(found.title)}` : `no window matches ${JSON.stringify(spec.match)}`,
          snapshotId: null
        };
      }
    } else {
      try {
        const found = await findUiLocked(
          { window: spec.window, query: spec.match, role: spec.role, maxResults: 1 },
          null
        );
        const present = found.elements.length > 0;
        if ((spec.until === 'ui_appears' && present) || (spec.until === 'ui_disappears' && !present)) {
          return {
            until: spec.until,
            elapsedMs: Date.now() - startedAt,
            detail: present
              ? `found ${found.elements[0]?.ref ?? 'matching control'}`
              : `no control matches ${JSON.stringify(spec.match)}`,
            snapshotId: found.snapshotId
          };
        }
      } catch (err) {
        if (
          spec.until === 'ui_disappears' &&
          err instanceof ComputerError &&
          /WINDOW_NOT_FOUND|UIA_FAILED: no accessible window/i.test(err.message)
        ) {
          return {
            until: spec.until,
            elapsedMs: Date.now() - startedAt,
            detail: 'target window/control is gone',
            snapshotId: null
          };
        }
        throw err;
      }
    }
    if (Date.now() >= deadline) {
      throw new ComputerError(`VERIFY_TIMEOUT: ${spec.until} was not satisfied within ${timeoutMs} ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
