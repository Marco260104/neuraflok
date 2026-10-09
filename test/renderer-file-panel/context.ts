import { JSDOM } from 'jsdom';
import type { LocalProject } from "../../contracts/workspace/projects.js";
import type { ProjectDirectoryListing, ProjectFilePreview, ProjectFilesChanged } from "../../contracts/workspace/project-files.js";
import type { ProjectGitChanged, ProjectGitSnapshot } from "../../contracts/workspace/project-git.js";
import { afterEach, beforeEach, vi } from 'vitest';
const panelMockState = vi.hoisted(() => ({
  createPdfViewer: vi.fn(),
  codeMount: { wait: null as Promise<void> | null, calls: 0 }
}));
const createPdfViewer = panelMockState.createPdfViewer;
const codeMount = panelMockState.codeMount;
export const rendererFilePanelMocks = { createPdfViewer, codeMount };

vi.mock('../../frontend/features/workspace/file-pdf-viewer.js', () => ({ createProjectPdfViewer: createPdfViewer }));

vi.mock('../../frontend/features/workspace/editors/code-editor.js', () => ({
  createProjectCodeEditor: async (options: { parent: HTMLElement; text: string; onChange?: (text: string) => void }) => {
    codeMount.calls++;
    if (codeMount.wait) await codeMount.wait;
    const input = document.createElement('textarea'); input.className = 'test-code-input'; input.value = options.text;
    options.parent.append(input);
    input.addEventListener('input', () => options.onChange?.(input.value));
    return { getValue: () => input.value, focus: () => input.focus(), destroy: () => input.remove(), language: 'Plain text' };
  }
}));

vi.mock('../../frontend/features/workspace/editors/diff-viewer.js', () => ({
  createProjectDiffViewer: async (options: { parent: HTMLElement; baseText: string; currentText: string }) => {
    const view = document.createElement('pre');
    view.className = 'test-diff-viewer';
    view.textContent = `${options.baseText}\n---\n${options.currentText}`;
    options.parent.append(view);
    return { destroy: () => view.remove(), language: 'TypeScript' };
  }
}));

export let dom: JSDOM;

export let host: HTMLElement;

export let toggle: HTMLButtonElement;

export let attached: string[];

export let projectFilesChanged: ((event: ProjectFilesChanged) => void) | null;

export let projectGitChanged: ((event: ProjectGitChanged) => void) | null;

export const projectA: LocalProject = { id: '11111111-1111-4111-8111-111111111111', name: 'alpha', path: 'C:\\alpha', createdAt: 1 };

export const projectB: LocalProject = { id: '22222222-2222-4222-8222-222222222222', name: 'beta', path: 'C:\\beta', createdAt: 2 };

export const rootListing = (project = projectA): ProjectDirectoryListing => ({
  projectId: project.id,
  projectName: project.name,
  directory: '',
  entries: [
    { name: 'src', path: 'src', kind: 'directory', bytes: null },
    { name: 'README.md', path: 'README.md', kind: 'file', bytes: 12 }
  ],
  truncated: false
});

export const preview: ProjectFilePreview = {
  projectId: projectA.id,
  projectName: projectA.name,
  path: 'README.md',
  name: 'README.md',
  bytes: 12,
  modifiedAt: new Date(0).toISOString(),
  revision: 'a'.repeat(64),
  binary: false,
  text: '# hello',
  truncated: false
};

export const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

export const cleanGit = (project = projectA): ProjectGitSnapshot => ({
  projectId: project.id, state: 'ready', changes: [], truncated: false, revision: 'clean'
});

export const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };

export const submitEntryDialog = async (value: string): Promise<void> => {
  const dialog = document.querySelector<HTMLDialogElement>('.file-entry-dialog')!;
  const input = dialog.querySelector<HTMLInputElement>('.file-entry-dialog-input')!;
  input.value = value;
  dialog.querySelector<HTMLFormElement>('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
};

beforeEach(() => {
  codeMount.wait = null; codeMount.calls = 0;
  dom = new JSDOM('<body><section id="host"></section><button id="toggle"></button></body>', { url: 'https://neuraflok.local/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  host = document.getElementById('host')!;
  toggle = document.getElementById('toggle') as HTMLButtonElement;
  attached = [];
  projectFilesChanged = null;
  projectGitChanged = null;
  createPdfViewer.mockReset();
  createPdfViewer.mockImplementation(async ({ parent }: { parent: HTMLElement }) => {
    const marker = document.createElement('div');
    marker.className = 'pdf-viewer-mock';
    parent.append(marker);
    return { destroy: vi.fn() };
  });
  Object.assign(dom.window, {
    api: {
      listProjectFiles: vi.fn((projectId: string, directory: string) => ok(directory === 'src'
        ? { ...rootListing(projectA), directory: 'src', entries: [{ name: 'main.ts', path: 'src/main.ts', kind: 'file', bytes: 20 }] }
        : rootListing(projectId === projectB.id ? projectB : projectA))),
      previewProjectFile: vi.fn(() => ok(preview)),
      watchProjectFiles: vi.fn(() => ok(true)),
      onProjectFilesChanged: vi.fn((listener: (event: ProjectFilesChanged) => void) => {
        projectFilesChanged = listener;
        return () => { if (projectFilesChanged === listener) projectFilesChanged = null; };
      }),
      getProjectGitSnapshot: vi.fn(() => ok(cleanGit())),
      getProjectGitDiff: vi.fn(),
      onProjectGitChanged: vi.fn((listener: (event: ProjectGitChanged) => void) => {
        projectGitChanged = listener;
        return () => { if (projectGitChanged === listener) projectGitChanged = null; };
      }),
      createProjectFileEntry: vi.fn(),
      renameProjectFileEntry: vi.fn(),
      deleteProjectFileEntry: vi.fn(),
      revealProjectFileEntry: vi.fn(() => ok(true)),
      attachProjectFile: vi.fn(() => ok({ id: 'file-1', name: 'README.md', size: 12, mimeType: 'text/markdown' })),
      saveProjectFile: vi.fn((_projectId: string, _path: string, text: string) => ok({ preview: { ...preview, text, revision: 'b'.repeat(64) } })),
      writeClipboard: vi.fn(() => ok(true))
    }
  });
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

export async function editFile(): Promise<HTMLTextAreaElement> {
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="Edit"]')!.click(); await tick();
  return host.querySelector<HTMLTextAreaElement>('.test-code-input')!;
}

export function typeEdit(input: HTMLTextAreaElement, text: string): void {
  input.value = text; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

