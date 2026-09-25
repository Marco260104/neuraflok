import {
  emptyWebProviderPresence,
  isWebProviderId,
  WEB_PROVIDERS,
  WEB_PROVIDER_IDS,
  type WebProviderId,
  type WebProviderPresenceMap
} from '../../../contracts/web-providers.js';

export const WEB_PROVIDER_PRESENCE_TTL_MS = 60_000;
const SIGHTING_GRACE_MS = 25_000;
let sightings = emptyWebProviderPresence();

export interface WebProviderPresenceUpdate {
  changed: boolean;
  changedStates: WebProviderId[];
  labels: Array<{ provider: WebProviderId; state: string }>;
}

export function recordWebProviderPresence(value: unknown, now = Date.now()): WebProviderPresenceUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { changed: false, changedStates: [], labels: [] };
  }

  const rows = value as Record<string, unknown>;
  const next = emptyWebProviderPresence();
  for (const [rawProvider, raw] of Object.entries(rows)) {
    if (!isWebProviderId(rawProvider) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as { open?: unknown; signedIn?: unknown; tabId?: unknown };
    if (row.open !== true || !Number.isSafeInteger(row.tabId) || (row.tabId as number) < 0) continue;
    const previous = sightings[rawProvider];
    const reportedSignedIn = typeof row.signedIn === 'boolean' ? row.signedIn : null;
    const signedIn = reportedSignedIn ?? (previous.open && previous.signedIn === true ? true : null);
    next[rawProvider] = {
      open: true,
      signedIn,
      tabId: row.tabId as number,
      lastSeenAt: now
    };
  }

  for (const provider of WEB_PROVIDER_IDS) {
    const previous = sightings[provider];
    if (!next[provider].open && previous.open && previous.lastSeenAt !== null && now - previous.lastSeenAt < SIGHTING_GRACE_MS) {
      next[provider] = { ...previous };
    }
  }

  const changed = WEB_PROVIDER_IDS.some(provider =>
    next[provider].open !== sightings[provider].open ||
    next[provider].signedIn !== sightings[provider].signedIn ||
    next[provider].tabId !== sightings[provider].tabId
  );
  const changedStates = WEB_PROVIDER_IDS.filter(provider =>
    next[provider].open !== sightings[provider].open ||
    next[provider].signedIn !== sightings[provider].signedIn
  );
  sightings = next;

  return {
    changed,
    changedStates,
    labels: changedStates.map(provider => {
      const sighting = sightings[provider];
      const state = !sighting.open ? 'not seen'
        : sighting.signedIn === true ? 'signed in'
          : sighting.signedIn === false ? 'open, signed out' : 'open, sign-in unknown';
      return { provider, state: `${WEB_PROVIDERS[provider].label} ${state}` };
    })
  };
}

export function readWebProviderPresence(serverRunning: boolean, now = Date.now()): WebProviderPresenceMap {
  return Object.fromEntries(WEB_PROVIDER_IDS.map(provider => {
    const sighting = sightings[provider];
    const fresh = serverRunning && sighting.lastSeenAt !== null && now - sighting.lastSeenAt < WEB_PROVIDER_PRESENCE_TTL_MS;
    return [provider, fresh ? sighting : {
      open: false,
      signedIn: null,
      tabId: null,
      lastSeenAt: sighting.lastSeenAt
    }];
  })) as WebProviderPresenceMap;
}

export function clearWebProviderPresence(provider: WebProviderId, now = Date.now()): boolean {
  const current = sightings[provider];
  if (!current.open && current.signedIn === null && current.tabId === null) return false;
  sightings[provider] = { open: false, signedIn: null, tabId: null, lastSeenAt: now };
  return true;
}

export function webProviderPresenceTimestamps(): Array<number | null> {
  return WEB_PROVIDER_IDS.map(provider => sightings[provider].lastSeenAt);
}

export function resetWebProviderPresence(): void {
  sightings = emptyWebProviderPresence();
}
