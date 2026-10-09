import { mountChat, settle } from './context.js';
import { emptyWebProviderPresence } from "../../contracts/web-providers.js";
import { expect, it, vi } from 'vitest';

it('surfaces the existing root rename API in the folder row', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'test stops before mutation' });
    }
  });
  const doc = mounted.window.document;
  const button = doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]');
  expect(button).not.toBeNull();

  button!.click();
  const input = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  input.value = 'New-Repo';
  input.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();

  expect(renames).toEqual([['repo', 'new-repo']]);
});

it('preserves an in-progress root rename across unrelated state pushes and cancels it if the root disappears', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'rename failed for retry test' });
    }
  });
  const doc = mounted.window.document;
  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();

  const original = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  original.value = 'new-name';
  original.setSelectionRange(3, 7);

  const unrelated = structuredClone(mounted.state) as any;
  mounted.push(unrelated);

  const preserved = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(preserved).not.toBeNull();
  expect(doc.activeElement).toBe(preserved);
  expect(preserved.value).toBe('new-name');
  expect(preserved.selectionStart).toBe(3);
  expect(preserved.selectionEnd).toBe(7);

  preserved.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name']]);
  const retry = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(retry.value).toBe('new-name');
  retry.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name'], ['repo', 'new-name']]);

  const escape = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  escape.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(doc.querySelector('.root-rename')).toBeNull();

  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();
  expect(doc.querySelector('.root-rename')).not.toBeNull();

  const removed = structuredClone(unrelated) as any;
  removed.config.roots = [];
  mounted.push(removed);
  expect(doc.querySelector('.root-rename')).toBeNull();
  expect(doc.querySelector('.root')).toBeNull();
});

it('guides rootless setup from the capabilities that actually need a filesystem root', async () => {
  const mounted = await mountChat();
  const ready = structuredClone(mounted.state) as any;
  ready.config.roots = [];
  ready.config.readOnly = false;
  for (const capability of Object.keys(ready.config.capabilities)) ready.config.capabilities[capability] = false;
  ready.config.capabilities.browse = true;
  ready.config.capabilities.screen = true;
  ready.bridge = {
    ...ready.bridge,
    present: true,
    paired: true,
    integratedExtension: { present: true },
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() } }
  };

  mounted.push(ready);
  const folder = mounted.window.document.querySelector<HTMLElement>('[data-step="folder"]')!;
  expect(folder.classList.contains('is-current')).toBe(true);
  expect(folder.classList.contains('is-done')).toBe(false);

  const command = structuredClone(ready);
  command.config.capabilities.browse = false;
  command.config.capabilities.command = true;
  mounted.push(command);
  expect(folder.classList.contains('is-current')).toBe(true);
  expect(folder.classList.contains('is-done')).toBe(false);

  const desktopOnly = structuredClone(ready);
  desktopOnly.config.capabilities.browse = false;
  mounted.push(desktopOnly);
  expect(folder.classList.contains('is-done')).toBe(true);
  expect(mounted.window.document.getElementById('readyTitle')!.textContent).toBe('You’re all set!');

  const clipboardOnly = structuredClone(desktopOnly);
  clipboardOnly.config.capabilities.screen = false;
  clipboardOnly.config.capabilities.clipboardRead = true;
  mounted.push(clipboardOnly);
  expect(folder.classList.contains('is-done')).toBe(true);
});

it('fills an empty folder list with a place to choose one, not a blank', async () => {
  const pick = vi.fn(() => Promise.resolve({ ok: true, data: null }));
  const mounted = await mountChat({}, [], { addRoot: pick });
  const empty = structuredClone(mounted.state);
  empty.config.roots = [];
  mounted.push(empty);
  const doc = mounted.window.document;
  const invite = doc.querySelector<HTMLButtonElement>('#wizFolders .folder-empty')!;
  expect(invite.textContent).toBe('No folder shared yet. Choose one to start.');
  invite.click();
  await settle();
  expect(pick).toHaveBeenCalled();
  // With a folder shared, the list shows it instead.
  mounted.push(structuredClone(mounted.state));
  expect(doc.querySelector('#wizFolders .folder-empty')).toBeNull();
  expect(doc.getElementById('wizFolders')!.textContent).toBe('/repo');
});

it('ends Setup on Ready, which names what is still open and leads back to it', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  doc.querySelector<HTMLButtonElement>('[data-rail-step="ready"]')!.click();
  expect(doc.querySelector('[data-step="ready"]')!.classList.contains('is-open')).toBe(true);
  expect(doc.getElementById('readyTitle')!.textContent).toBe('Almost there');
  expect(doc.getElementById('readyStart')!.hidden).toBe(true);
  const pending = [...doc.querySelectorAll<HTMLButtonElement>('#readyChecks .ready-go')];
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.map(button => button.textContent)).toContain('Step 1Connect a provider');
  pending.find(button => button.textContent!.includes('Connect a provider'))!.click();
  expect(doc.querySelector('[data-step="browser"]')!.classList.contains('is-open')).toBe(true);
  expect(doc.getElementById('browserExtensionStage')).toBeNull();
  expect((doc.getElementById('browserLocationStage') as HTMLElement).hidden).toBe(false);
});

it('asks what the selected provider can do, and read-only explains its limits', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const access = doc.querySelector<HTMLElement>('[data-step="access"]')!;
  const choice = (level: string) => doc.querySelector<HTMLButtonElement>(`[data-access="${level}"]`)!;

  // The fixture shares a folder with every permission on: the step is done, on Full access.
  expect(access.classList.contains('is-done')).toBe(true);
  expect(choice('full').getAttribute('aria-checked')).toBe('true');
  expect(doc.getElementById('accessNote')!.hidden).toBe(true);

  // Read-only, as an older install or a recovered settings file leaves it: the step is done (setup can still end on all set), but it says why, and Ready says what is limited and how to change it.
  const readOnly = structuredClone(mounted.state);
  readOnly.config.readOnly = true;
  readOnly.settingsRecovered = true;
  mounted.push(readOnly);
  expect(access.classList.contains('is-done')).toBe(true);
  expect(choice('read').getAttribute('aria-checked')).toBe('true');
  expect(doc.getElementById('accessRecovered')!.hidden).toBe(false);
  expect(doc.getElementById('accessNote')!.classList.contains('is-warn')).toBe(true);
  expect(doc.getElementById('readyLimited')!.hidden).toBe(false);
  expect(doc.querySelector('#readyChecks .ready-check.is-passed.is-limited')!.textContent).toBe('NEURAFLOK can only read files');
  doc.getElementById('readyChangeAccess')!.click();
  expect(access.classList.contains('is-open')).toBe(true);

  // Files and terminal turns read-only off and Desktop off in one save.
  choice('files').click();
  await settle();
  const saved = mounted.calls.at(-1);
  expect(saved.readOnly).toBe(false);
  for (const cap of ['create', 'edit', 'move', 'deleteFile', 'command']) expect(saved.capabilities[cap], cap).toBe(true);
  for (const cap of ['screen', 'control', 'clipboardRead', 'clipboardWrite']) expect(saved.capabilities[cap], cap).toBe(false);

  expect(doc.querySelector('[data-panel="setup"] .connectors')).toBeNull();

  // A mix from Workspace without commands is custom, and explains the access the provider has.
  const custom = structuredClone(mounted.state);
  custom.config.capabilities.command = false;
  mounted.push(custom);
  for (const level of ['full', 'files', 'read']) expect(choice(level).getAttribute('aria-checked')).toBe('false');
  expect(doc.getElementById('readyLimited')!.hidden).toBe(false);
  expect(doc.getElementById('accessNote')!.textContent).toMatch(/^These permissions prevent the selected provider from editing files or running commands/);
});

it('keeps both access pickers keyboard-operable and closes the compact picker after selection', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const setupFull = doc.querySelector<HTMLButtonElement>('.access-choice [data-access="full"]')!;
  setupFull.focus();
  setupFull.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await settle();
  expect(mounted.calls.at(-1)?.readOnly).toBe(false);

  const composer = doc.getElementById('composerAccess') as HTMLDetailsElement;
  composer.open = true;
  const composerFull = doc.querySelector<HTMLButtonElement>('#composerAccessChoice [data-access="full"]')!;
  composerFull.focus();
  composerFull.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  await settle();
  expect(mounted.calls.at(-1)?.readOnly).toBe(true);
  expect(composer.open).toBe(false);
  expect(doc.activeElement).toBe(doc.getElementById('composerAccessTrigger'));
});

it('keeps the integrated provider setup stable across app-state pushes', async () => {
  const mounted = await mountChat();
  const state = structuredClone(mounted.state) as any;
  mounted.push(state);
  const doc = mounted.window.document;
  expect(doc.querySelector('[data-step="tunnel"]')).toBeNull();
  expect(doc.getElementById('setupProfile')).toBeNull();
  expect(doc.getElementById('browserExtensionStage')).toBeNull();
  expect(doc.getElementById('openExtensionSettings')).toBeNull();
  expect(doc.getElementById('bridgeFolder')).toBeNull();
  expect(doc.querySelectorAll('[data-setup-guide]')).toHaveLength(0);
  const providerStage = doc.getElementById('browserLocationStage')!;
  expect(providerStage.hidden).toBe(false);
  mounted.push(structuredClone(state));
  expect(doc.getElementById('browserLocationStage')).toBe(providerStage);
  expect(mounted.calls).toEqual([]);
  mounted.push(structuredClone(state));
});
