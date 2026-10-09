import { dom, editFile, host, ok, projectA, projectB, projectFilesChanged, rendererFilePanelMocks, rootListing, tick, toggle, typeEdit } from './context.js';
const createPdfViewer = rendererFilePanelMocks.createPdfViewer;

import { createFilePanel } from "../../frontend/features/workspace/file-panel.js";
import { createAgentPanel } from "../../frontend/features/agents/agent-panel.js";
import type { ProjectFilePreview } from "../../contracts/workspace/project-files.js";
import { expect, it, vi } from 'vitest';

it('lets the file preview expand vertically over the tree and persists that height', async () => {
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 900 });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  const previewPane = host.querySelector<HTMLElement>('.file-preview')!;
  const handle = previewPane.querySelector<HTMLElement>('.file-preview-resize')!;
  expect(handle.getAttribute('role')).toBe('separator');
  expect(handle.getAttribute('aria-orientation')).toBe('horizontal');

  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(previewPane.style.height).toMatch(/^\d+px$/);
  expect(Number.parseInt(previewPane.style.height, 10)).toBeGreaterThanOrEqual(160);
  expect(dom.window.localStorage.getItem('neuraflok.file-preview-height')).toBe(previewPane.style.height.replace('px', ''));
});

it('keeps the same PDF viewer mounted across unrelated panel repaints and unchanged watcher refreshes', async () => {
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

  const firstHost = host.querySelector<HTMLElement>('.file-pdf-viewer-host')!;
  const firstMarker = host.querySelector<HTMLElement>('.pdf-viewer-mock')!;
  expect(createPdfViewer).toHaveBeenCalledTimes(1);

  // Session-list paints call filePanel.update() even when the selected project did not change.
  panel.update(projectA); await tick();
  expect(createPdfViewer).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.file-pdf-viewer-host')).toBe(firstHost);
  expect(host.querySelector('.pdf-viewer-mock')).toBe(firstMarker);

  // A directory watcher event also repaints the tree and reloads preview metadata. If the PDF revision is unchanged, neither pass is allowed to tear down the mounted viewer.
  projectFilesChanged?.({ projectId: projectA.id, directory: '' });
  await tick(); await tick();
  expect(createPdfViewer).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.file-pdf-viewer-host')).toBe(firstHost);
  expect(host.querySelector('.pdf-viewer-mock')).toBe(firstMarker);
});

it('remounts the PDF viewer only when the selected PDF revision actually changes', async () => {
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
  let currentPreview = pdfPreview;
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'paper.pdf', path: 'paper.pdf', kind: 'file', bytes: currentPreview.bytes }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(currentPreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="paper.pdf"]')!.click(); await tick();
  const firstHost = host.querySelector<HTMLElement>('.file-pdf-viewer-host')!;
  expect(createPdfViewer).toHaveBeenCalledTimes(1);

  currentPreview = {
    ...pdfPreview,
    modifiedAt: new Date(1).toISOString(),
    pdfDataBase64: Buffer.from('%PDF-1.4\n% changed\n%%EOF').toString('base64')
  };
  projectFilesChanged?.({ projectId: projectA.id, directory: '' });
  await tick(); await tick();
  expect(createPdfViewer).toHaveBeenCalledTimes(2);
  expect(host.querySelector('.file-pdf-viewer-host')).not.toBe(firstHost);
});

it('keeps the original synchronous vertical resize behavior while a PDF is open', async () => {
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

  const previewPane = host.querySelector<HTMLElement>('.file-preview')!;
  const handle = previewPane.querySelector<HTMLElement>('.file-preview-resize')!;
  let captured = false;
  Object.assign(handle, {
    setPointerCapture: () => { captured = true; },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => { captured = false; }
  });
  const pointer = (type: string, y: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    return event;
  };

  handle.dispatchEvent(pointer('pointerdown', 300));
  handle.dispatchEvent(pointer('pointermove', 180));
  // PDF-specific fixes must not change the shared preview separator's original immediate drag.
  expect(Number.parseInt(previewPane.style.height, 10)).toBeGreaterThan(200);
  handle.dispatchEvent(pointer('pointerup', 180));
  expect(dom.window.localStorage.getItem('neuraflok.file-preview-height')).toBe(previewPane.style.height.replace('px', ''));
  expect(captured).toBe(false);
  expect(createPdfViewer).toHaveBeenCalledTimes(1);
});

it('drops stale directory results after switching projects', async () => {
  let resolveOld!: (value: any) => void;
  (window.api.listProjectFiles as any) = vi.fn((projectId: string) => {
    if (projectId === projectA.id) return new Promise(resolve => { resolveOld = resolve; });
    return ok(rootListing(projectB));
  });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await Promise.resolve();
  panel.update(projectB); await tick();
  resolveOld({ ok: true, data: rootListing(projectA) }); await tick();

  expect(host.textContent).toContain('beta');
  expect(host.textContent).not.toContain('alpha');
  expect((window.api.listProjectFiles as any)).toHaveBeenCalledWith(projectB.id, '');
});

it('closes immediately when the selected task no longer has a project', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  expect(panel.visible()).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(true);
  panel.update(null);
  expect(panel.visible()).toBe(false);
  expect(toggle.hidden).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(false);
});

it('shares the right work slot exclusively with the Sub-agents panel', async () => {
  const agentToggle = document.createElement('button');
  document.body.append(agentToggle);
  let files: ReturnType<typeof createFilePanel>;
  const agents = createAgentPanel({
    host,
    toggle: agentToggle,
    onShow: () => files.hide(),
    load: async () => ({ events: [] }),
    render: () => [],
    openMain: () => undefined,
    working: () => false
  });
  files = createFilePanel({
    host,
    toggle,
    onShow: () => agents.hide(),
    onAttach: () => undefined
  });
  files.update(projectA);
  agents.update('prime-session', [{
    id: 'worker-session', title: 'Worker', conversationId: 'worker-conversation',
    startedAt: 1, updatedAt: 1, endedAt: null, events: 0, agents: ['worker-1'],
    estimatedTokens: 0, contextTokens: 0,
    origin: { kind: 'worker', fromSessionId: 'prime-session', agentId: 'worker-1', task: 'Inspect' }
  } as any]);

  toggle.click(); await tick();
  expect(files.visible()).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(true);
  expect(host.classList.contains('has-agent-panel')).toBe(false);

  agentToggle.click(); await tick();
  expect(files.visible()).toBe(false);
  expect(host.classList.contains('has-file-panel')).toBe(false);
  expect(host.classList.contains('has-agent-panel')).toBe(true);

  toggle.click(); await tick();
  expect(files.visible()).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(true);
  expect(host.classList.contains('has-agent-panel')).toBe(false);
});

it('gives Files and Sub-agents the same horizontally resizable work-panel width', async () => {
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1200 });
  const agentToggle = document.createElement('button');
  document.body.append(agentToggle);
  const agents = createAgentPanel({
    host, toggle: agentToggle, load: async () => ({ events: [] }), render: () => [],
    openMain: () => undefined, working: () => false
  });
  const files = createFilePanel({ host, toggle, onAttach: () => undefined });
  files.update(projectA);

  const fileHandle = host.querySelector<HTMLElement>('.file-panel .work-panel-resize')!;
  expect(fileHandle.getAttribute('role')).toBe('separator');
  fileHandle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  const width = host.style.getPropertyValue('--work-panel-width');
  expect(width).toMatch(/^\d+px$/);

  agents.update('prime-session', []);
  const agentHandle = host.querySelector<HTMLElement>('.agent-panel .work-panel-resize')!;
  expect(agentHandle.getAttribute('aria-valuenow')).toBe(width.replace('px', ''));
  agentHandle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(host.style.getPropertyValue('--work-panel-width')).not.toBe(width);
});

it.each(['New file', 'New folder'])('protects the active draft before %s changes selection', async label => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile(); typeEdit(input, 'keep this draft');
  host.querySelector<HTMLButtonElement>(`[title="${label}"]`)!.click(); await tick();
  expect(document.querySelector('.file-confirm-dialog')).not.toBeNull();
  expect(document.querySelector('.file-entry-dialog')).toBeNull();
  document.querySelector<HTMLButtonElement>('.file-confirm-dialog .btn')!.click(); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('keep this draft');
  expect(window.api.createProjectFileEntry).not.toHaveBeenCalled();

  host.querySelector<HTMLButtonElement>(`[title="${label}"]`)!.click(); await tick();
  document.querySelector<HTMLButtonElement>('.file-confirm-dialog .file-dialog-danger')!.click(); await tick();
  expect(document.querySelector('.file-entry-dialog')).not.toBeNull();
});

