import type { AppState } from '../../../contracts/types.js';
import { usesApiProvider, usesBrowserProvider } from '../../../contracts/chat-protocol.js';
import { requiresApprovedFilesystemRoot } from '../../../contracts/capabilities.js';
import { WEB_PROVIDERS, isWebProviderId, type WebProviderId } from '../../../contracts/web-providers.js';
import { $, ago, el, shortAgo } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

interface ProviderStatusViewOptions {
  getState: () => AppState | null;
  apiProviderConfigured: (state: AppState) => boolean;
  apiProviderWorkspaceLabel: (state: AppState) => string;
  toolsOn: (state: AppState) => number;
}

export function createProviderStatusView(options: ProviderStatusViewOptions) {
  function providerPresence(bridge: AppState['bridge'], provider: WebProviderId) {
    return bridge.webProviders?.[provider];
  }

  function webProviderWorkspaceLabel(next: AppState): string {
    const provider = isWebProviderId(next.config.ui.webProvider) ? next.config.ui.webProvider : 'deepseek';
    const presence = providerPresence(next.bridge, provider);
    if (!next.bridge.present) return t('Extension offline');
    if (presence?.signedIn === true) return `${t('System active')} · ${WEB_PROVIDERS[provider].label}`;
    if (presence?.open && presence.signedIn === false) return `${WEB_PROVIDERS[provider].label} · ${t('Sign in')}`;
    if (presence?.open) return `${WEB_PROVIDERS[provider].label} · ${t('Checking')}`;
    return `${WEB_PROVIDERS[provider].label} · ${t('Not detected')}`;
  }

  function paintWebProviderSighting(node: HTMLElement, bridge: AppState['bridge'], provider: WebProviderId): void {
    const sighting = providerPresence(bridge, provider);
    const open = sighting?.open === true;
    const signedIn = sighting?.signedIn ?? null;
    ui(node, 'textContent', () => signedIn === true
      ? t('Session active')
      : open
        ? signedIn === false ? t('Sign in') : t('Checking')
        : bridge.present ? t('Not detected') : t('Extension offline'));
    node.dataset.tone = signedIn === true ? 'ok' : open ? (signedIn === false ? 'wait' : 'ok') : 'bad';
  }

  function facts(next: AppState): HTMLElement[] {
    const { bridge, config } = next;
    const selectedProvider = isWebProviderId(config.ui.webProvider) ? config.ui.webProvider : 'deepseek';
    const presence = providerPresence(bridge, selectedProvider);
    const extensionStatus = bridge.present ? t('Connected') : bridge.paired ? t('Paired · not active') : t('Not connected');
    const providerStatus = usesBrowserProvider(config.ui.chatExecutor)
      ? webProviderWorkspaceLabel(next)
      : options.apiProviderWorkspaceLabel(next);
    const providerReady = usesBrowserProvider(config.ui.chatExecutor)
      ? presence?.signedIn === true
      : options.apiProviderConfigured(next);
    const rows: [string, () => string, boolean?][] = [
      ['Browser extension', () => extensionStatus, !bridge.present],
      [usesBrowserProvider(config.ui.chatExecutor) ? 'Web session' : 'API model', () => providerStatus, !providerReady],
      [
        'Local tools',
        () => t(config.roots.length === 1 ? '{0} total · {1} folder' : '{0} total · {1} folders', [options.toolsOn(next), config.roots.length])
      ]
    ];
    return rows.map(([label, value, bad]) => {
      const row = el('div', 'fact');
      const code = el('code', bad ? 'is-bad' : '', value);
      ui(code, 'title', value);
      row.append(el('span', '', () => t(label)), code);
      return row;
    });
  }

  function checks(next: AppState) {
    const browserExecutor = usesBrowserProvider(next.config.ui.chatExecutor);
    const selectedProvider = isWebProviderId(next.config.ui.webProvider) ? next.config.ui.webProvider : 'deepseek';
    const presence = providerPresence(next.bridge, selectedProvider);
    const extensionRequired = browserExecutor;
    const extensionStatus = next.bridge.present ? 'pass' : extensionRequired ? 'fail' : 'skipped';
    const providerReady = browserExecutor ? presence?.signedIn === true : options.apiProviderConfigured(next);
    const providerStatus = browserExecutor
      ? presence?.signedIn === true ? 'pass' : presence?.open ? 'fail' : 'not-run'
      : providerReady ? 'pass' : 'fail';
    const rootRequired = requiresApprovedFilesystemRoot(next.config);
    const rootsStatus = next.config.roots.length > 0 ? 'pass' : rootRequired ? 'fail' : 'skipped';
    const enabledTools = options.toolsOn(next);
    const checks = [
      {
        name: 'Browser extension',
        status: extensionStatus,
        detail: next.bridge.present ? t('The local browser companion is connected.')
          : extensionRequired ? t('The browser companion has not connected yet.') : t('The API route does not require a browser session.')
      },
      {
        name: browserExecutor ? WEB_PROVIDERS[selectedProvider].label : 'API model',
        status: providerStatus,
        detail: browserExecutor
          ? presence?.signedIn === true ? t('The provider page is open and signed in.')
            : presence?.open ? t('Sign in to {0} in the integrated browser.', [WEB_PROVIDERS[selectedProvider].label])
            : t('Open {0} in the integrated browser and sign in.', [WEB_PROVIDERS[selectedProvider].label])
          : providerReady ? t('The configured API model is ready.') : t('Choose an API model and configure its endpoint or key.')
      },
      {
        name: 'Approved folder',
        status: rootsStatus,
        detail: next.config.roots.length > 0 ? t('A workspace folder is approved.')
          : rootRequired ? t('Approve a folder before using file tools.') : t('No enabled local tool currently requires a folder.')
      },
      {
        name: 'Local tools',
        status: enabledTools > 0 ? 'pass' : 'skipped',
        detail: enabledTools > 0 ? t('{0} local tools are enabled.', [enabledTools]) : t('No local tools are enabled.')
      }
    ] as const;
    const summary = checks.some(check => check.status === 'fail')
      ? t('Some checks need attention.')
      : t('All required checks passed.');
    return { checks, summary };
  }

  function paintClock(): void {
    const snapshot = options.getState();
    if (!snapshot) return;
    const { bridge, config } = snapshot;
    const extensionActive = bridge.present;
    const extensionLabel = extensionActive ? t('Connected') : bridge.paired ? t('Paired · not active') : t('Not connected');
    const extension = $('connectionPopoverBrowser');
    extension.textContent = extensionLabel;
    extension.dataset.status = extensionActive ? 'connected' : bridge.paired ? 'paired' : 'disconnected';
    ui($('bigHandshake'), 'textContent', () => extensionLabel);
    $('bigHandshake').className = extensionActive ? '' : 'is-bad';
    $('bigRequest').textContent = shortAgo(bridge.lastSeenAt);
    $('bigRequest').className = bridge.lastSeenAt === null ? 'is-cold' : '';

    const selectedProvider = isWebProviderId(config.ui.webProvider) ? config.ui.webProvider : 'deepseek';
    for (const id of Object.keys(WEB_PROVIDERS) as WebProviderId[]) {
      const suffix = `${id[0]!.toUpperCase()}${id.slice(1)}`;
      paintWebProviderSighting($<HTMLElement>(`connectionPopover${suffix}Status`), bridge, id);
    }
    const browserRow = extension.parentElement!;
    const providerRows = (Object.keys(WEB_PROVIDERS) as WebProviderId[]).map(id => {
      const suffix = `${id[0]!.toUpperCase()}${id.slice(1)}`;
      return $<HTMLElement>(`connectionPopover${suffix}Status`).parentElement!;
    });
    browserRow.dataset.tone = extensionActive ? 'ok' : bridge.paired ? 'wait' : 'bad';
    ui(browserRow, 'title', () => bridge.lastSeenAt ? t('Seen {0}', [ago(bridge.lastSeenAt)]) : extensionLabel);
    for (const [index, id] of (Object.keys(WEB_PROVIDERS) as WebProviderId[]).entries()) {
      const suffix = `${id[0]!.toUpperCase()}${id.slice(1)}`;
      const node = $<HTMLElement>(`connectionPopover${suffix}Status`);
      const sighting = providerPresence(bridge, id);
      providerRows[index]!.dataset.tone = node.dataset.tone ?? 'bad';
      ui(providerRows[index]!, 'title', () => sighting?.lastSeenAt ? t('Seen {0}', [ago(sighting.lastSeenAt)]) : node.textContent ?? '');
    }

    const selectedPresence = providerPresence(bridge, selectedProvider);
    const selectedLabel = WEB_PROVIDERS[selectedProvider].label;
    $('connectionPopoverProviderAction').textContent = selectedPresence?.signedIn === true
      ? `${t('Open')} ${selectedLabel}`
      : t('Sign in to {0} to connect your account.', [selectedLabel]);
    const title = usesApiProvider(config.ui.chatExecutor)
      ? options.apiProviderWorkspaceLabel(snapshot)
      : webProviderWorkspaceLabel(snapshot);
    ui($('connectionPopoverTitle'), 'textContent', () => title);
    ui($('connectionPopoverTitle'), 'title', () => title);

    const trigger = $('sidebarConnection');
    ui(trigger, 'aria-label', () => title);
    ui(trigger, 'title', () => title);
  }

  return { checks, facts, paintClock, providerPresence, webProviderWorkspaceLabel };
}
