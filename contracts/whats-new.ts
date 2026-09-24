import { isNewer, RELEASES_PAGE } from './types.js';

/** Decides whether this launch shows the What's New dialog. */
export function whatsNewAction(current: string, lastSeen: string | undefined, hasHighlights: (version: string) => boolean): 'show' | 'record' | 'none' {
  if (lastSeen === current) return 'none';
  if (lastSeen !== undefined && !isNewer(current, lastSeen)) return 'record';
  return hasHighlights(current) ? 'show' : 'record';
}

/** Returns the release notes URL when the project has a release page. */
export function releaseNotesUrl(version: string): string | null {
  return RELEASES_PAGE ? RELEASES_PAGE.replace(/\/latest$/, `/tag/v${encodeURIComponent(version)}`) : null;
}
