import { attached, dom, host, ok, preview, projectA, projectFilesChanged, projectGitChanged, rendererFilePanelMocks, rootListing, submitEntryDialog, tick, toggle } from './context.js';
const createPdfViewer = rendererFilePanelMocks.createPdfViewer;

import { createFilePanel } from "../../frontend/features/workspace/file-panel.js";
import type { ProjectFilePreview } from "../../contracts/workspace/project-files.js";
import type { ProjectGitDiff, ProjectGitSnapshot } from "../../contracts/workspace/project-git.js";
import { expect, it, vi } from 'vitest';

it('keeps tree focus through directory loading and supports arrow, parent and boundary navigation', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const key = async (key: string) => {
    document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await tick();
  };
  const focusedPath = () => (document.activeElement as HTMLElement).dataset.path;
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.focus();
  await key('ArrowRight');
  expect(focusedPath()).toBe('src');
  await key('ArrowRight'); expect(focusedPath()).toBe('src/main.ts');
  await key('ArrowLeft'); expect(focusedPath()).toBe('src');
  await key('ArrowLeft'); expect(focusedPath()).toBe('src');
  expect(host.querySelector('[data-path="src/main.ts"]')).toBeNull();
  await key('ArrowDown'); expect(focusedPath()).toBe('README.md');
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick();
  expect(focusedPath()).toBe('README.md');
  await key('Home'); expect(focusedPath()).toBe('');
  await key('End'); expect(focusedPath()).toBe('README.md');
  expect(host.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
  expect(window.api.previewProjectFile).not.toHaveBeenCalled();
});

it.each(['README.md', 'example.ts'])('preserves unchanged %s preview DOM during session and directory refreshes', async name => {
  let value = { ...preview, path: name, name };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({ ...rootListing(), entries: [{ name, path: name, kind: 'file', bytes: 12 }] }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok({ ...value }));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>(`[data-path="${name}"]`)!.click(); await tick();
  const content = host.querySelector('.file-preview-markdown, .file-code-viewer-host')!;
  const treeRow = host.querySelector(`[data-path="${name}"]`);
  for (let i = 0; i < 10; i++) panel.update({ ...projectA });
  await tick();
  expect(host.querySelector(`[data-path="${name}"]`)).toBe(treeRow);
  expect(host.querySelector('.file-preview-markdown, .file-code-viewer-host')).toBe(content);
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick(); await tick();
  expect(host.querySelector('.file-preview-markdown, .file-code-viewer-host')).toBe(content);
  value = { ...value, text: '# changed', revision: 'b'.repeat(64) };
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick(); await tick();
  expect(host.querySelector('.file-preview-markdown, .file-code-viewer-host')).not.toBe(content);
  expect(host.querySelector('.file-preview')?.textContent || host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBeTruthy();
});

it('lets the preview occupy the panel and restores the tree when it closes', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('.file-preview-toggle-tree')!.click();
  expect(host.querySelector('.file-panel-body')?.classList.contains('is-reading')).toBe(true);
  expect(host.querySelector('.file-preview-toggle-tree')?.getAttribute('aria-pressed')).toBe('false');
  host.querySelector<HTMLButtonElement>('.file-preview-close')!.click(); await tick();
  expect(host.querySelector('.file-panel-body')?.classList.contains('is-reading')).toBe(false);
});

it('refreshes a watched directory automatically when the filesystem changes', async () => {
  let listing = rootListing(projectA);
  (window.api.listProjectFiles as any) = vi.fn(() => ok(listing));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  expect(host.textContent).not.toContain('generated.ts');

  listing = {
    ...listing,
    entries: [...listing.entries, { name: 'generated.ts', path: 'generated.ts', kind: 'file', bytes: 10 }]
  };
  projectFilesChanged?.({ projectId: projectA.id, directory: '' });
  await tick();

  expect((window.api.listProjectFiles as any)).toHaveBeenLastCalledWith(projectA.id, '');
  expect(host.textContent).toContain('generated.ts');
});

it('retires a pending Git reconciliation when the panel closes', async () => {
  const panel = createFilePanel({ host, toggle });
  panel.update(projectA); toggle.click(); await tick(); await tick();
  const before = (window.api.getProjectGitSnapshot as any).mock.calls.length;
  projectGitChanged?.({ projectId: projectA.id });
  toggle.click();
  await new Promise(resolve => setTimeout(resolve, 150));
  expect((window.api.getProjectGitSnapshot as any)).toHaveBeenCalledTimes(before);
});

it('previews and attaches a selected project file without exposing a native path', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: file => attached.push(file.name) });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  expect((window.api.previewProjectFile as any)).toHaveBeenCalledWith(projectA.id, 'README.md');
  expect(host.querySelector('.file-preview-markdown h1')?.textContent).toBe('hello');
  const attach = [...host.querySelectorAll<HTMLButtonElement>('.file-preview-actions button')]
    .find(button => button.title === 'Attach')!;
  attach.click(); await tick();
  expect((window.api.attachProjectFile as any)).toHaveBeenCalledWith(projectA.id, 'README.md');
  expect(attached).toEqual(['README.md']);
  expect(JSON.stringify((window.api.attachProjectFile as any).mock.calls)).not.toContain('C:\\alpha');
});

it('uses the file name as the title and its relative path as metadata in file and diff previews', async () => {
  const nestedPreview = { ...preview, path: 'src/main.ts', name: 'main.ts', text: 'export {}' };
  (window.api.previewProjectFile as any).mockImplementation(() => ok(nestedPreview));
  (window.api.getProjectGitSnapshot as any).mockImplementation(() => ok({
    projectId: projectA.id,
    state: 'ready',
    changes: [{ status: 'M', path: 'src/main.ts', additions: 1, deletions: 0, binary: false }],
    truncated: false,
    revision: 'nested-dirty'
  } satisfies ProjectGitSnapshot));
  (window.api.getProjectGitDiff as any).mockImplementation(() => ok({
    projectId: projectA.id,
    status: 'M',
    path: 'src/main.ts',
    additions: 1,
    deletions: 0,
    binary: false,
    tooLarge: false,
    baseText: '',
    currentText: 'export {}'
  } satisfies ProjectGitDiff));

  const panel = createFilePanel({ host, toggle });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="src/main.ts"]')!.click(); await tick();
  expect(host.querySelector('.file-preview-title > strong')?.textContent).toBe('main.ts');
  expect(host.querySelector('.file-preview-meta')?.textContent).toContain('src/main.ts');

  host.querySelector<HTMLButtonElement>('.file-panel-changes-toggle')!.click(); await tick(); await tick();
  host.querySelector<HTMLButtonElement>('.file-change-row[data-path="src/main.ts"]')!.click(); await tick(); await tick();
  expect(host.querySelector('.file-preview-title > strong')?.textContent).toBe('main.ts');
  expect(host.querySelector('.file-preview-meta')?.textContent).toContain('src/main.ts');
});

it('lets the user close only the file preview without closing Files or changing the selection', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  const close = [...host.querySelectorAll<HTMLButtonElement>('.file-preview-actions button')]
    .find(button => button.title === 'Close preview')!;
  expect(close).toBeTruthy();
  close.click(); await tick();

  expect(host.querySelector<HTMLElement>('.file-preview')!.hidden).toBe(true);
  expect(panel.visible()).toBe(true);
  expect(host.querySelector('[data-path="README.md"]')?.classList.contains('is-selected')).toBe(true);
});

it('creates files and folders and renames entries through an in-app name dialog', async () => {
  (window.api.createProjectFileEntry as any) = vi.fn((projectId: string, directory: string, name: string, kind: 'file' | 'directory') =>
    ok({ projectId, path: directory ? `${directory}/${name}` : name, kind }));
  (window.api.renameProjectFileEntry as any) = vi.fn((projectId: string, _oldPath: string, name: string) =>
    ok({ projectId, path: name, kind: 'file' }));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const action = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.file-panel-toolbar button')]
    .find(button => button.textContent?.includes(label))!;

  action('New file').click();
  expect(document.querySelector('.file-entry-dialog h2')?.textContent).toBe('New file');
  await submitEntryDialog('notes.txt');
  expect((window.api.createProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, '', 'notes.txt', 'file');

  action('New folder').click();
  expect(document.querySelector('.file-entry-dialog h2')?.textContent).toBe('New folder');
  await submitEntryDialog('docs');
  expect((window.api.createProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, '', 'docs', 'directory');

  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  action('Rename').click();
  expect(document.querySelector<HTMLInputElement>('.file-entry-dialog-input')?.value).toBe('README.md');
  await submitEntryDialog('README-renamed.md');
  expect((window.api.renameProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, 'README.md', 'README-renamed.md');
});

it('uses an in-app confirmation before moving a selected item to the Trash', async () => {
  (window.api.deleteProjectFileEntry as any) = vi.fn(() => ok(true));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  const remove = [...host.querySelectorAll<HTMLButtonElement>('.file-panel-toolbar button')]
    .find(button => button.textContent?.includes('Delete'))!;

  remove.click();
  expect(document.querySelector('.file-confirm-dialog h2')?.textContent).toBe('Delete item?');
  expect(document.querySelector('.file-confirm-dialog')?.textContent).toContain('Move “README.md” to the Trash?');
  expect((window.api.deleteProjectFileEntry as any)).not.toHaveBeenCalled();

  document.querySelector<HTMLButtonElement>('.file-confirm-dialog .file-dialog-danger')!.click();
  await tick();
  expect((window.api.deleteProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, 'README.md');
  expect(document.querySelector('.file-confirm-dialog')).toBeNull();
});

it('loads the contents of a newly created expanded folder without waiting for a watch event', async () => {
  let created = false;
  (window.api.listProjectFiles as any) = vi.fn((_projectId: string, directory: string) => ok(directory === 'docs'
    ? { ...rootListing(), directory, entries: [] }
    : { ...rootListing(), entries: [...rootListing().entries, ...(created ? [{ name: 'docs', path: 'docs', kind: 'directory', bytes: null }] : [])] }));
  (window.api.createProjectFileEntry as any) = vi.fn(() => {
    created = true;
    return ok({ projectId: projectA.id, path: 'docs', kind: 'directory' });
  });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="New folder"]')!.click();
  await submitEntryDialog('docs');
  expect(window.api.listProjectFiles).toHaveBeenCalledWith(projectA.id, 'docs');
  expect(host.querySelector('[data-path="docs"]')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.file-tree-status')).toBeNull();
});

it('loads an expanded renamed folder under its new path and retires its old child paths', async () => {
  let name = 'src';
  (window.api.listProjectFiles as any) = vi.fn((_projectId: string, directory: string) => ok(directory === ''
    ? { ...rootListing(), entries: [{ name, path: name, kind: 'directory', bytes: null }] }
    : { ...rootListing(), directory, entries: [{ name: 'main.ts', path: `${directory}/main.ts`, kind: 'file', bytes: 20 }] }));
  (window.api.renameProjectFileEntry as any) = vi.fn(() => {
    name = 'code';
    return ok({ projectId: projectA.id, path: 'code', kind: 'directory' });
  });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="Rename"]')!.click();
  await submitEntryDialog('code');
  expect(host.querySelector('[data-path="code/main.ts"]')).not.toBeNull();
  expect(host.querySelector('[data-path="src/main.ts"]')).toBeNull();
  expect(host.querySelector('.file-tree-status')).toBeNull();
  expect(window.api.watchProjectFiles).toHaveBeenLastCalledWith(projectA.id, ['', 'code']);
});

it('keeps one compact toolbar and closes through the Files toggle', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();

  const disclosure = host.querySelector<HTMLElement>('[data-path="src"] .file-tree-disclosure')!;
  expect(disclosure.textContent).toBe('');
  expect(disclosure.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelector('.file-panel-header')).toBeNull();
  expect(host.querySelector('.file-panel-close')).toBeNull();
  expect(host.querySelector('.file-panel-toolbar .file-panel-refresh')).not.toBeNull();
  expect(host.querySelector('.file-panel-toolbar')?.lastElementChild?.classList.contains('file-panel-refresh')).toBe(true);
  expect(host.querySelector('.file-panel-toolbar-actions')?.contains(host.querySelector('.file-panel-changes-toggle'))).toBe(true);
  expect(host.querySelector('.file-panel-toolbar-actions')?.contains(host.querySelector('.file-panel-refresh'))).toBe(false);
  toggle.click(); await tick();
  expect(host.querySelector<HTMLElement>('.file-panel')!.hidden).toBe(true);
});

it('renders markdown semantically and strips executable or remote-media markup', async () => {
  const markdown: ProjectFilePreview = {
    ...preview,
    text: '# Heading\n\nA **bold** paragraph with a [safe link](https://example.com) and [dead fragment](#heading).\n\n```text\nlong code line\n```\n\n<script>alert(1)</script>\n\n![remote](https://example.com/image.png)'
  };
  (window.api.previewProjectFile as any) = vi.fn(() => ok(markdown));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  const rendered = host.querySelector<HTMLElement>('.file-preview-markdown')!;
  expect(rendered.querySelector('h1')?.textContent).toBe('Heading');
  expect(rendered.querySelector('strong')?.textContent).toBe('bold');
  expect(rendered.querySelector('pre code')?.textContent).toContain('long code line');
  expect(rendered.querySelector('script')).toBeNull();
  expect(rendered.querySelector('img')).toBeNull();
  expect([...rendered.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))).toEqual(['https://example.com', null]);
});

it('renders supported image previews inline instead of the generic binary placeholder', async () => {
  const imagePreview: ProjectFilePreview = {
    projectId: projectA.id,
    projectName: projectA.name,
    path: 'Perfil.jpg',
    name: 'Perfil.jpg',
    bytes: 12,
    modifiedAt: new Date(0).toISOString(),
    binary: true,
    text: null,
    imageMimeType: 'image/jpeg',
    imageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    truncated: false
  };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'Perfil.jpg', path: 'Perfil.jpg', kind: 'file', bytes: 12 }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(imagePreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="Perfil.jpg"]')!.click(); await tick();

  const image = host.querySelector<HTMLImageElement>('.file-preview-image')!;
  expect(image).not.toBeNull();
  expect(image.src).toBe(imagePreview.imageDataUrl);
  expect(image.alt).toBe('Perfil.jpg');
  expect(host.textContent).not.toContain('Binary file · preview unavailable');
});

it('mounts the in-app PDF viewer from project-scoped bytes without exposing a native path', async () => {
  const pdfPreview: ProjectFilePreview = {
    projectId: projectA.id,
    projectName: projectA.name,
    path: 'paper.pdf',
    name: 'paper.pdf',
    bytes: 24,
    modifiedAt: new Date(0).toISOString(),
    binary: true,
    text: null,
    pdfDataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    truncated: false
  };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'paper.pdf', path: 'paper.pdf', kind: 'file', bytes: pdfPreview.bytes }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(pdfPreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="paper.pdf"]')!.click(); await tick();

  expect(createPdfViewer).toHaveBeenCalledWith(expect.objectContaining({
    parent: expect.any(HTMLElement),
    filename: 'paper.pdf',
    dataBase64: pdfPreview.pdfDataBase64
  }));
  expect(host.querySelector('.file-pdf-viewer-host')).not.toBeNull();
  expect(JSON.stringify(createPdfViewer.mock.calls)).not.toContain('C:\\alpha');
  expect(host.textContent).not.toContain('Binary file · preview unavailable');
});

