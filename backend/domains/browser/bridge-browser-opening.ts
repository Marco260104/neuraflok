import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import { isWebProviderId, providerForConversationId, WEB_PROVIDERS, type WebProviderId } from '../../../contracts/web-providers.js';
import type { Config } from '../../../contracts/types.js';
import type { ReasoningEffort } from '../../../contracts/session.js';
import type { Command, CommandSpec } from './command-broker/model.js';

type Runtime = {
  getConfig(): Config;
  browserPresent(): boolean;
  commandHomeConversation(spec: CommandSpec): string | null;
  drop(command: Command, reason: string): boolean;
  specKey(spec: CommandSpec): string;
  logInfo(message: string): void;
  deliver(): Promise<void>;
};

type BrowserOpener = (url: string) => Promise<void>;

export function createBridgeBrowserOpening(runtime: Runtime) {
  let openInBrowser: BrowserOpener | null = null;
  let lastBrowserLaunchAt = 0;

  function setBrowserOpener(open: BrowserOpener | null): void {
    openInBrowser = open;
  }

  function selectedWebProvider(): WebProviderId {
    const selected = runtime.getConfig().ui.webProvider;
    return isWebProviderId(selected) ? selected : 'deepseek';
  }

  function chatUrl(conversationId: string): string {
    const provider = providerForConversationId(conversationId);
    if (provider) return WEB_PROVIDERS[provider].chatUrl;
    if (isApiConversationId(conversationId) || !/^[0-9a-f-]{8,64}$/i.test(conversationId)) {
      throw new Error('This conversation has no supported provider page.');
    }
    return WEB_PROVIDERS[selectedWebProvider()].chatUrl;
  }

  function commandUrl(
    id: string,
    provider: WebProviderId,
    model?: string | null,
    reasoningEffort?: ReasoningEffort | null
  ): string {
    const marker = `neuraflok-command=${encodeURIComponent(id)}`;
    const url = new URL(WEB_PROVIDERS[provider].chatUrl);
    url.searchParams.set('neuraflok-command', id);
    if (model) url.searchParams.set('neuraflok-model', model);
    if (reasoningEffort) url.searchParams.set('neuraflok-reasoning', reasoningEffort);
    url.hash = marker;
    return url.toString();
  }

  async function openFreshChatInBrowser(command: Command): Promise<void> {
    const home = runtime.commandHomeConversation(command.spec);
    if (home && isApiConversationId(home)) {
      runtime.drop(command, 'API conversations cannot receive browser bridge commands');
      return;
    }
    const provider = (home ? providerForConversationId(home) : null) ?? selectedWebProvider();
    const opener = openInBrowser;
    if (!opener) {
      runtime.drop(command, 'this app has no way to open a browser window');
      return;
    }
    runtime.logInfo(`bridge: opening a fresh ${provider} chat for ${runtime.specKey(command.spec)}`);
    try {
      if (!runtime.browserPresent()) lastBrowserLaunchAt = Date.now();
      command.progress = { ...command.progress, opened: 'os' };
      await opener(command.spec.type === 'worker'
        ? commandUrl(command.id, provider, command.spec.model, command.spec.reasoningEffort)
        : commandUrl(command.id, provider));
    } catch (err) {
      const why = `the browser could not be opened (${err instanceof Error ? err.message : String(err)})`;
      command.lastError = why;
      runtime.drop(command, why);
      await runtime.deliver();
    }
  }

  function reset(): void {
    openInBrowser = null;
    lastBrowserLaunchAt = 0;
  }

  return {
    chatUrl,
    commandUrl,
    hasOpener: () => openInBrowser !== null,
    lastBrowserLaunchAt: () => lastBrowserLaunchAt,
    openFreshChatInBrowser,
    openInBrowser: () => openInBrowser,
    reset,
    setBrowserOpener
  };
}
