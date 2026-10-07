/** Runs the opt-in Windows capture, accessibility, and input smoke. */
import { pathToFileURL } from 'node:url';
import { runWindowsDesktopSmoke } from './windows-desktop-smoke/run.mjs';

export { runWindowsDesktopSmoke } from './windows-desktop-smoke/run.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runWindowsDesktopSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
