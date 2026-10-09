import { mountChat } from './context.js';
import { emptyWebProviderPresence } from "../../contracts/web-providers.js";
import { readRendererStyleSource } from "../../scripts/read-renderer-style-source.cjs";

/** jsdom has no modal dialogs: enough of showModal/close for the app's dialogs, close event included. */
import { expect, it, vi } from 'vitest';

it('does not expose retired tunnel setup fields beside browser provider setup', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  expect(doc.getElementById('browserWebProvider')).not.toBeNull();
  expect(doc.getElementById('openBrowserProvider')).not.toBeNull();
  for (const id of ['tunnelId', 'apiKey', 'desktopTunnelId', 'binaryPath', 'tunnelKind']) {
    expect(doc.getElementById(id)).toBeNull();
  }
  expect(mounted.calls).toEqual([]);
});

it('shows each provider’s own sign-in state in Settings and Setup', async () => {
  const mounted = await mountChat();
  const state = structuredClone(mounted.state);
  state.bridge = {
    ...state.bridge,
    running: true,
    paired: true,
    present: true,
    integratedExtension: { present: true },
    webProviders: {
      ...emptyWebProviderPresence(),
      deepseek: { open: true, signedIn: true, tabId: 31, lastSeenAt: Date.now() },
      kimi: { open: true, signedIn: false, tabId: 32, lastSeenAt: Date.now() },
      qwen: { open: true, signedIn: null, tabId: 33, lastSeenAt: Date.now() }
    }
  };
  mounted.push(state);
  const doc = mounted.window.document;
  expect(doc.getElementById('providerStatusDeepseek')!.textContent).toBe('Session active');
  expect(doc.getElementById('providerStatusKimi')!.textContent).toBe('Sign in required');
  expect(doc.getElementById('providerStatusQwen')!.textContent).toBe('Checking session');
  expect(doc.getElementById('providerStatusGlm')!.textContent).toBe('Not detected');
  expect(doc.querySelector<HTMLButtonElement>('[data-select-provider="deepseek"]')!.disabled).toBe(false);
  for (const id of ['kimi', 'qwen', 'glm']) {
    expect(doc.querySelector<HTMLButtonElement>(`[data-select-provider="${id}"]`)!.disabled).toBe(true);
  }
  expect(doc.querySelector('[data-step="browser"]')!.classList.contains('is-done')).toBe(true);
  expect((doc.getElementById('browserLocationStage') as HTMLElement).hidden).toBe(false);
});

it('keeps folder access discoverable after setup and navigates without granting access', async () => {
  const addRoot = vi.fn();
  const mounted = await mountChat({ hasApiKey: true }, [], { addRoot });
  const connected = structuredClone(mounted.state);
  connected.bridge = { ...connected.bridge, present: true, paired: true,
    integratedExtension: { present: true },
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() } } };
  mounted.push(connected);
  mounted.window.document.querySelector<HTMLButtonElement>('[data-rail-step=ready]')!.click();
  const doc = mounted.window.document;
  const styles = doc.createElement('style');
  styles.textContent = readRendererStyleSource(process.cwd());
  doc.head.append(styles);
  doc.querySelector<HTMLButtonElement>('[data-tab="setup"]')!.click();

  // A finished setup opens on its proof: every check passed, and the way into a chat. There is no guide to hide any more; each step stays one click away on the rail.
  expect(doc.getElementById('wizExpand')).toBeNull();
  expect(doc.querySelector('[data-step="ready"]')!.classList.contains('is-open')).toBe(true);
  // A finished setup leads with its proof: every check passed, and the way into a chat.
  expect(doc.getElementById('readyTitle')!.textContent).toBe('You’re all set!');
  expect(doc.getElementById('readyStart')!.hidden).toBe(false);
  expect(doc.querySelectorAll('#readyChecks .ready-check.is-passed')).toHaveLength(3);
  expect(mounted.window.getComputedStyle(doc.getElementById('readyChecks')!).display).not.toBe('none');
  doc.querySelector<HTMLButtonElement>('[data-rail-step="folder"]')!.click();
  const manage = doc.getElementById('wizManageFolders')!;
  expect(mounted.window.getComputedStyle(manage.parentElement!).display).not.toBe('none');
  expect(doc.getElementById('wizFolders')!.textContent).toBe('/repo');
  manage.click();

  expect(doc.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('home');
  expect(doc.activeElement).toBe(doc.getElementById('addFolder'));
  expect(doc.getElementById('rootList')!.textContent).toContain('/repo');
  expect(addRoot).not.toHaveBeenCalled();
  expect(mounted.calls).toEqual([]);
}, 60_000);

it('keeps the app-wide options on the General page, not in Setup, and saves them from there', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const general = doc.querySelector('[data-panel="general"]')!;
  const setup = doc.querySelector('[data-panel="setup"]')!;
  for (const id of ['followOutput', 'mentionCore', 'privacyScreenshots', 'developerMode', 'controlApiEnabled', 'controlApiAllowActions']) {
    expect(general.contains(doc.getElementById(id)), id).toBe(true);
    expect(setup.contains(doc.getElementById(id)), id).toBe(false);
  }
  doc.querySelector<HTMLButtonElement>('#tabs [data-tab="general"]')!.click();
  expect(doc.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('general');
  expect(doc.querySelector('#tabs [data-tab="general"]')!.classList.contains('is-sel')).toBe(true);
  // Allow actions needs the control API first.
  expect(doc.getElementById('controlApiAllowActions')!.hasAttribute('disabled')).toBe(true);
  const follow = doc.getElementById('followOutput') as HTMLInputElement;
  expect(follow.checked).toBe(true);
  follow.checked = false;
  follow.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.ui.followOutput).toBe(false));
});

it('requires both the companion extension and a selected provider session before Setup is ready', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const browserStep = doc.querySelector<HTMLElement>('[data-step="browser"]')!;
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('browserExtensionStage')).toBeNull();
  expect(doc.getElementById('browserContinue')).toBeNull();
  expect(doc.getElementById('bridgeFolder')).toBeNull();
  expect((doc.getElementById('browserLocationStage') as HTMLElement).hidden).toBe(false);
  expect(browserStep.classList.contains('is-done')).toBe(false);

  const extensionReady = structuredClone(mounted.state);
  extensionReady.bridge = {
    ...extensionReady.bridge,
    running: true,
    paired: true,
    present: true,
    integratedExtension: { present: true },
    webProviders: emptyWebProviderPresence()
  };
  mounted.push(extensionReady);
  expect((doc.getElementById('browserLocationStage') as HTMLElement).hidden).toBe(false);
  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect(doc.getElementById('browserProviderStatusDeepseek')!.textContent).toBe('Not detected');

  const providerReady = structuredClone(extensionReady);
  providerReady.bridge.webProviders.deepseek = { open: true, signedIn: true, tabId: 41, lastSeenAt: Date.now() };
  mounted.push(providerReady);
  expect(browserStep.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('readyTitle')!.textContent).toBe('You’re all set!');
});

it('says nothing about being current until the check has actually answered', async () => {
  const mounted = await mountChat({
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.2' }
  });
  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.hidden).toBe(true);
  expect(doc.querySelector('.toast')).toBeNull();

  const checked = structuredClone(mounted.state) as any;
  checked.update.checkedAt = Date.now();
  mounted.push(checked);

  // Green, both versions, and the same sentence as the one notification this window shows.
  expect(line.hidden).toBe(false);
  expect(line.className).toBe('upline is-ok');
  expect(line.textContent).toBe('Up to date! NEURAFLOK 2.0.2 · extension 2.0.2');
  expect(doc.querySelector('.toast')!.textContent).toBe(line.textContent);
  // Nothing to act on, so the header bar stays out of the way.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);

  // The news is told once. A later push of the same fact repaints the line and nothing else.
  doc.querySelector('.toast')!.remove();
  mounted.push(structuredClone(checked) as any);
  expect(doc.querySelector('.toast')).toBeNull();
  expect(line.textContent).toBe('Up to date! NEURAFLOK 2.0.2 · extension 2.0.2');
});

it('reports a staged update in the Activity line and the header bar', async () => {
  const mounted = await mountChat();
  const staged = structuredClone(mounted.state) as any;
  staged.bridge = { ...staged.bridge, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: staged.update.current };
  staged.update = { current: '2.0.2', latest: '2.0.3', stage: 'ready', error: null, checkedAt: Date.now() };
  mounted.push(staged);

  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.className).toBe('upline');
  expect(line.textContent).toContain('2.0.3 is downloaded and ready');
  expect(doc.getElementById('updateNotice')!.hidden).toBe(false);
  // There is nothing to fetch by hand once it is on disk.
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  // ...and this is the one state in which there is something to install. Both buttons show, because a tray app closed to the tray may not see the header for days.
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(false);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(false);

  const checking = structuredClone(staged) as any;
  checking.update.stage = 'checking';
  mounted.push(checking);
  expect(line.textContent).toContain('Checking for the latest update');
  expect(line.textContent).not.toContain('by hand');
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  // Still downloading is not yet installable: there is no verified file to hand over.
  const downloading = structuredClone(staged) as any;
  downloading.update = { ...downloading.update, stage: 'downloading' };
  mounted.push(downloading);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);

  const broken = structuredClone(staged) as any;
  broken.update = { current: '2.0.2', latest: null, stage: 'failed', error: 'latest answered 503', checkedAt: null };
  mounted.push(broken);
  expect(line.className).toBe('upline is-bad');
  expect(line.textContent).toContain('503');
  // A check that could not reach GitHub is a diagnostic, not something the user can act on.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);
});

it('asks for an extension reload only when the extension is older than this app', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1'
    }
  });
  const doc = mounted.window.document;
  const notice = doc.getElementById('updateNotice')!;
  expect(notice.hidden).toBe(false);
  expect(doc.getElementById('updateText')!.textContent).toContain('2.0.1');
  const action = doc.getElementById('updateExtension') as HTMLButtonElement;
  expect(action.hidden).toBe(false);
  action.click();
  expect(doc.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
  const rejected = structuredClone(mounted.state) as any;
  rejected.bridge.present = false;
  mounted.push(rejected);
  expect(notice.hidden, 'an old companion rejected by the protocol gate still needs an update').toBe(false);

  const ahead = structuredClone(mounted.state) as any;
  ahead.bridge.extensionVersion = '2.0.3';
  mounted.push(ahead);
  expect(notice.hidden, 'a newer extension is not a downgrade prompt').toBe(true);
  expect(action.hidden).toBe(true);
});

it('shows a missing-extension reminder while connected and clears it after the companion reports in', async () => {
  const mounted = await mountChat();
  const connected = structuredClone(mounted.state) as any;
  connected.bridge.running = true; connected.bridge.present = false;
  mounted.push(connected);
  const doc = mounted.window.document;
  expect(doc.getElementById('updateText')!.textContent).toContain('Browser extension not connected');
  expect(doc.getElementById('updateExtension')!.hidden).toBe(false);
  connected.bridge.present = true; connected.bridge.extensionVersion = connected.update.current;
  mounted.push(connected);
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
});
