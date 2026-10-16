export const REPLACEMENT_CHAT_CLAIM_WINDOW_MS = 60_000;

type ReplacementChatClaim =
  | { state: 'opening'; expiresAt: number }
  | { state: 'dispatched' };

const claims = new Map<string, ReplacementChatClaim>();

function expectReplacementChat(token: string): void {
  if (claims.get(token)?.state === 'dispatched') return;
  claims.set(token, { state: 'opening', expiresAt: Date.now() + REPLACEMENT_CHAT_CLAIM_WINDOW_MS });
}

export function expectReplacementChatOpening(token: string): void {
  expectReplacementChat(token);
}

export function recordReplacementChatClaim(token: string): void {
  expectReplacementChat(token);
}

export function recordReplacementDispatch(token: string): void {
  claims.set(token, { state: 'dispatched' });
}

export function releaseReplacementChatClaim(token: string): void {
  claims.delete(token);
}

export function hasPendingReplacementChat(now: number = Date.now()): boolean {
  for (const [token, claim] of claims) {
    if (claim.state === 'dispatched' || now <= claim.expiresAt) return true;
    claims.delete(token);
  }
  return false;
}

export function resetReplacementChatClaims(): void {
  claims.clear();
}
