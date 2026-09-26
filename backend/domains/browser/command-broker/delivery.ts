import type { ReasoningEffort } from '../../../../contracts/session.js';
import { continuationByToken } from '../../sessions/continuity/continuation.js';
import type { Command, CommandSpec } from './model.js';

const PLACEMENT_FALLBACK_MS = 60_000;

export interface BrowserPlacement {
  id: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  background?: true;
  active: boolean;
  homeConversationId: string | null;
}

interface Runtime {
  getCommands(): Command[];
  commandHomeConversation(spec: CommandSpec): string | null;
  browserWakeConnected(): boolean;
  chatHolders(conversationId: string): string[];
  placementCollector(): string | null;
  backgroundChats(): boolean;
  wakeBrowserWork(): void;
  browserPresent(): boolean;
  browserLaunchGraceMs: number;
  lastBrowserLaunchAt(): number;
  openInBrowser(): ((url: string) => Promise<void>) | null;
  openFreshChatInBrowser(command: Command): Promise<void>;
  persistCommandLease(command: Command, owner: string | null, claimedAt: number): Promise<boolean>;
  armDeadline(command: Command): void;
  changed(): void;
  expectReplacementChatOpening(token: string): void;
  tidyCommands(): void;
  nextDeliverable(): Command | null;
  drop(command: Command, reason: string): boolean;
  scheduleDeliver(): void;
  specKey(spec: CommandSpec): string;
  logInfo(message: string): void;
  deliver(): Promise<void>;
}

export function createBridgeCommandDelivery(runtime: Runtime) {
  let browserLaunchTimer: NodeJS.Timeout | null = null;

  function browserLaunchPending(now = Date.now()): boolean {
    return !runtime.browserPresent() && now < runtime.lastBrowserLaunchAt() + runtime.browserLaunchGraceMs;
  }

  function deliverAfterLaunchWindow(now = Date.now()): void {
    if (browserLaunchTimer) return;
    browserLaunchTimer = setTimeout(() => {
      browserLaunchTimer = null;
      void runtime.deliver();
    }, Math.max(1, runtime.lastBrowserLaunchAt() + runtime.browserLaunchGraceMs - now + 1));
    browserLaunchTimer.unref?.();
  }

  function offerPlacement(command: Command): boolean {
    const home = runtime.commandHomeConversation(command.spec);
    const worker = command.spec.type === 'worker' && runtime.browserWakeConnected();
    const held = command.spec.type === 'resume' && home !== null && runtime.chatHolders(home).length > 0;
    if (!worker && !held && (!home || home !== runtime.placementCollector())) return false;
    command.placement = { conversationId: home, background: worker && runtime.backgroundChats() };
    if (worker || (held && home !== runtime.placementCollector())) runtime.wakeBrowserWork();
    return true;
  }

  function pendingBrowserPlacement(conversationId: string | null, browser: string | null = null): BrowserPlacement | null {
    const command = runtime.getCommands().find(entry => entry.owner === null && entry.placement &&
      (entry.placement.conversationId === conversationId || (conversationId === null && (entry.spec.type === 'worker' ||
        (entry.spec.type === 'resume' && browser !== null && entry.placement.conversationId !== null &&
          runtime.chatHolders(entry.placement.conversationId).includes(browser))))));
    if (!command?.placement) return null;
    const placement = command.placement;
    delete command.placement;
    command.progress = { ...command.progress, opened: 'browser' };
    const spec = command.spec;
    const worker = spec.type === 'worker';
    const selection = spec.type === 'resume' ? continuationByToken(spec.token)?.requestedModel : null;
    return {
      id: command.id,
      model: worker ? spec.model : selection?.model ?? null,
      reasoningEffort: worker ? spec.reasoningEffort : selection?.reasoningEffort ?? null,
      active: !worker,
      homeConversationId: placement.conversationId,
      ...(placement.background ? { background: true as const } : {})
    };
  }

  function armPlacementFallback(command: Command): void {
    const timer = setTimeout(() => {
      const current = runtime.getCommands().find(entry => entry.id === command.id);
      if (!current || current.owner !== null) return;
      delete current.placement;
      runtime.logInfo(`bridge: the browser did not open ${runtime.specKey(current.spec)} within ${Math.round(PLACEMENT_FALLBACK_MS / 1000)}s — opening it from here instead`);
      void runtime.openFreshChatInBrowser(current);
    }, PLACEMENT_FALLBACK_MS);
    timer.unref?.();
  }

  async function deliverOne(): Promise<void> {
    runtime.tidyCommands();
    const command = runtime.nextDeliverable();
    if (!command) return;
    if (!runtime.openInBrowser()) {
      runtime.drop(command, 'this app has no way to open a browser window');
      return;
    }
    if (browserLaunchPending()) {
      deliverAfterLaunchWindow();
      return;
    }
    const claimedAt = Date.now();
    if (!await runtime.persistCommandLease(command, null, claimedAt)) return;
    runtime.armDeadline(command);
    runtime.changed();
    if (command.spec.type === 'resume') runtime.expectReplacementChatOpening(command.spec.token);
    try {
      if (offerPlacement(command)) armPlacementFallback(command);
      else await runtime.openFreshChatInBrowser(command);
    } finally {
      runtime.scheduleDeliver();
    }
  }

  function reset(): void {
    if (browserLaunchTimer) clearTimeout(browserLaunchTimer);
    browserLaunchTimer = null;
  }

  return { deliverOne, pendingBrowserPlacement, reset };
}
