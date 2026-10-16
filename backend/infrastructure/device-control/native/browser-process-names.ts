const browserNames = ['chrome', 'chromium', 'msedge', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'safari'];

export const BROWSER_PROCESS_PATTERN = new RegExp(String.raw`(^|[\s_-])(${browserNames.join('|')})([\s_-]|$)`);

export function isBrowserProcess(process: string): boolean {
  const name = process.trim().toLowerCase().replace(/\.exe$/, '');
  return BROWSER_PROCESS_PATTERN.test(name);
}
