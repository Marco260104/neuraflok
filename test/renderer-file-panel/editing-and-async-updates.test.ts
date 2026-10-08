import { dom, editFile, host, ok, preview, projectA, projectB, projectFilesChanged, rendererFilePanelMocks, submitEntryDialog, tick, toggle, typeEdit } from './context.js';
const codeMount = rendererFilePanelMocks.codeMount;

import { createFilePanel } from "../../frontend/features/workspace/file-panel.js";
import type { ProjectFilePreview, ProjectFilesChanged } from "../../contracts/workspace/project-files.js";
import { expect, it, vi } from 'vitest';

it('retains an unsaved editor draft through a project A-B-A round trip', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile(); typeEdit(input, 'my unsaved changes');
  panel.update(projectB); await tick();
  panel.update(projectA); await tick(); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('my unsaved changes');
  expect(host.querySelector<HTMLButtonElement>('.file-editor-save')?.disabled).toBe(false);
});

it('moves the same Files pane between docks without losing an unsaved editor draft', async () => {
  const right = document.createElement('div'), bottom = document.createElement('div');
  host.append(right, bottom);
  const panel = createFilePanel({ host, mount: right, toggle });
  panel.update(projectA); await panel.show(); await tick();
  const input = await editFile(); typeEdit(input, 'dock draft');
  const pane = right.querySelector('.file-panel');
  panel.hide(); panel.mountAt(bottom); await panel.show(); await tick();
  expect(bottom.querySelector('.file-panel')).toBe(pane);
  expect(bottom.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('dock draft');
  expect(bottom.querySelector<HTMLButtonElement>('.file-editor-save')?.disabled).toBe(false);
});

it('keeps edits typed while a save is pending and ignores a duplicate save', async () => {
  let finish!: (value: unknown) => void;
  (window.api.saveProjectFile as any) = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile(); typeEdit(input, 'first draft');
  const save = host.querySelector<HTMLButtonElement>('.file-editor-save')!; save.click(); await tick();
  typeEdit(input, 'newer draft');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  expect(window.api.saveProjectFile).toHaveBeenCalledTimes(1);
  finish({ ok: true, data: { preview: { ...preview, text: 'first draft', revision: 'b'.repeat(64) } } }); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('newer draft');
  expect(save.disabled).toBe(false);
});

it('does not overwrite edits typed while a watcher preview read is in flight', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile();
  let finish!: (value: unknown) => void;
  (window.api.previewProjectFile as any) = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick();
  typeEdit(input, 'typed during read');
  finish({ ok: true, data: { ...preview, text: 'external revision', revision: 'b'.repeat(64) } }); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('typed during read');
});

it('captures attachment delivery before staging rather than after a chat switch', async () => {
  let currentChat = 'a'; const delivered: string[] = [];
  let finish!: (value: unknown) => void;
  (window.api.attachProjectFile as any) = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const panel = createFilePanel({ host, toggle, captureAttachment: () => {
    const owner = currentChat;
    return () => { if (owner !== currentChat) return false; delivered.push(owner); return true; };
  } });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="Attach"]')!.click(); await tick();
  currentChat = 'b'; panel.update(projectA);
  finish({ ok: true, data: { id: 'file-1', name: 'README.md', size: 12, mimeType: 'text/markdown' } }); await tick();
  expect(delivered).toEqual([]);
});

it('cancels a stale name dialog after a project A-B-A round trip', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="New file"]')!.click();
  panel.update(projectB); panel.update(projectA); await tick();
  await submitEntryDialog('stale.txt');
  expect(window.api.createProjectFileEntry).not.toHaveBeenCalled();
});

it('expands the work panel beyond 60 percent while retaining space for chat', () => {
  host.getBoundingClientRect = () => ({ width: 2200 } as DOMRect);
  createFilePanel({ host, toggle, onAttach: () => undefined });
  const handle = host.querySelector<HTMLElement>('.work-panel-resize')!;
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End' }));
  expect(host.style.getPropertyValue('--work-panel-width')).toBe('1840px');
  expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(2200 * .6);
  host.getBoundingClientRect = () => ({ width: 1000 } as DOMRect);
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(host.style.getPropertyValue('--work-panel-width')).toBe('640px');
});

it('keeps the previous preview during a pending file read and ignores a superseded read', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const row = host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!;
  row.click(); await tick();
  const surface = host.querySelector('.file-preview-markdown');
  let complete!: (value: any) => void;
  window.api.previewProjectFile = vi.fn(() => new Promise<{ ok: true; data: ProjectFilePreview }>(resolve => { complete = resolve; }));
  row.click(); await tick();
  expect(host.querySelector('.file-preview-markdown')).toBe(surface);
  expect(host.textContent).not.toContain('Loading preview');
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  complete({ ok: true, data: { ...preview, text: '# stale' } }); await tick();
  expect(host.querySelector<HTMLElement>('.file-preview')!.hidden).toBe(true);
});

it('does not restart a pending code mount when the directory watcher refreshes', async () => {
  const code = { ...preview, path: 'README.md', name: 'example.ts', text: 'const answer = 42;' };
  window.api.previewProjectFile = vi.fn(() => ok(code));
  let release!: () => void;
  codeMount.wait = new Promise<void>(resolve => { release = resolve; });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  expect(codeMount.calls).toBe(1);
  projectFilesChanged?.({ projectId: projectA.id, directory: '' } as ProjectFilesChanged); await tick();
  expect(codeMount.calls).toBe(1);
  release(); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe(code.text);
});

