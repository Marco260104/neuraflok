import type { BrowserCommand, BrowserResult } from '../../../../contracts/browser/control-policy.js';

export interface ConnectedBrowser {
  id: string;
  name: string;
  enabled: boolean;
  seenAt: number;
}

export interface BrowserOwnerProof {
  owner: string;
  sessionId: string;
}

export interface PendingBrowserRequest {
  browserId: string;
  command: BrowserCommand;
  claimed: boolean;
  claiming: boolean;
  allowed: () => Promise<boolean>;
  resolve: (result: BrowserResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}
