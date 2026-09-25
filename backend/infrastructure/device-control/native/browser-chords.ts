import { normalizeKeyChord } from './keyboard-chords/normalize.js';
import { isReservedBrowserChord } from './keyboard-chords/reservations.js';

export { BROWSER_PROCESS_PATTERN, isBrowserProcess } from './browser-process-names.js';

export function browserTabChord(keys: readonly string[]): string | null {
  const chord = normalizeKeyChord(keys);
  return chord && isReservedBrowserChord(chord) ? chord : null;
}
