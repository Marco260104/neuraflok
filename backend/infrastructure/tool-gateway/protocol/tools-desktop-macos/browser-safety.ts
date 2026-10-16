import { activeWindow, listWindows, type Action } from '../../../device-control/native/index.js';
import { browserTabChord, isBrowserProcess } from '../../../device-control/native/browser-chords.js';

function newBrowserWindowHint(): string {
  return process.platform === 'darwin'
    ? 'open -na "Google Chrome" --args --new-window "$url"'
    : "Start-Process chrome.exe -ArgumentList '--new-window', $url";
}

export async function browserChordRefusal(actions: Action[]): Promise<string | null> {
  let focused: number | null = null;
  for (const action of actions) {
    if (action.type === 'focus') focused = action.window;
    if (action.type !== 'keypress') continue;
    const chord = browserTabChord(action.keys);
    if (!chord) continue;
    const target = focused === null
      ? (await activeWindow()).window
      : ((await listWindows()).windows.find(window => window.id === focused) ?? null);
    if (!target || !isBrowserProcess(target.process)) continue;
    return (
      `BROWSER_TAB_CHORD: ${chord} would close, open or switch tabs or windows of "${target.title}" (${target.process}). ` +
      'A browser here may be holding a provider session this app runs, and a chord cannot tell which tab it lands on, so ' +
      'tab and window chords are refused in every browser window. Open the page you are testing in a browser window of its ' +
      `own (${newBrowserWindowHint()}), keep that window in front, and drive it there — ` +
      'navigate with set_value on its address bar, never by keyboard tab or window chords.'
    );
  }
  return null;
}
