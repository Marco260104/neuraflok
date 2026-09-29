import { PROJECT_COLORS, type LocalProject, type ProjectColor } from '../../../contracts/workspace/projects.js';
import type { SessionSummary } from '../../../contracts/session.js';
import type { ComposerAttachment } from './chat-composer-attachments.js';
import type { NewChatTaskDraft } from './chat-draft-state.js';
import type { RowMenuItem } from './row-menu.js';

export interface ChatProjectControlsRuntime {
  api: Pick<typeof window.api, 'removeProject' | 'setProjectColor'>;
  run: typeof import('../../shared/dom.js').run;
  toast: typeof import('../../shared/dom.js').toast;
  t: typeof import('../../shared/i18n.js').t;
  ui: typeof import('../../shared/i18n.js').ui;
  $: typeof import('../../shared/dom.js').$;
  projects: LocalProject[];
  sessions: SessionSummary[];
  selectedId: string | null;
  selectedProjectId: string | null;
  selectionGeneration: number;
  sessionsLoadGeneration: number;
  newChatSelected: boolean;
  expandedProjects: Set<string>;
  projectVisibleCounts: Map<string, number>;
  draftKey: () => string;
  authoredComposerText: () => string;
  replaceComposerDraft: () => void;
  inputDrafts: Pick<Map<string, string>, 'delete' | 'set'>;
  newChatTasks: Pick<Map<string, NewChatTaskDraft>, 'delete'>;
  imageDrafts: Map<string, ComposerAttachment[]>;
  restoreSkills: () => void;
  paintSessions: () => void;
  refreshInputQueue: () => Promise<void>;
}

type Runtime = ChatProjectControlsRuntime;

// Owns sidebar project grouping, project menu actions, and selected-project lookup.
export function createChatProjectControls(runtime: Runtime) {
  const savingProjectColor = new Set<string>();
  const removingProject = new Set<string>();

  function projectGroup(id: string | null | undefined): string | null {
    return id && !runtime.projects.find((project) => project.id === id)?.ungrouped ? id : null;
  }

  function rowMenuButton(owner: string): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>('[data-row-menu]')]
      .find((button) => button.dataset.rowMenu === owner) ?? null;
  }

  function projectMenuItems(id: string): RowMenuItem[] {
    const color = runtime.projects.find((project) => project.id === id)?.color ?? null;
    return [
      {
        action: 'color',
        icon: 'i-palette',
        label: () => runtime.t('Color'),
        title: () => runtime.t('Change project color'),
        submenu: () => ([null, ...PROJECT_COLORS] as const).map((choice) => ({
          action: `color-${choice ?? 'none'}`,
          swatch: choice ?? '',
          checked: color === choice,
          disabled: savingProjectColor.has(id),
          label: () => choice ? projectColorName(choice) : runtime.t('None'),
          run: () => void saveProjectColor(id, choice)
        }))
      },
      {
        action: 'remove',
        icon: 'i-trash',
        danger: true,
        separated: true,
        disabled: removingProject.has(id),
        label: () => runtime.t('Remove'),
        title: () => runtime.t('Remove project from sidebar; keep conversations and files'),
        run: () => void removeProjectFromSidebar(id)
      }
    ];
  }

  async function saveProjectColor(id: string, choice: ProjectColor | null): Promise<void> {
    const project = runtime.projects.find((row) => row.id === id);
    if (!project || savingProjectColor.has(id) || (project.color ?? null) === choice) return;
    savingProjectColor.add(id);
    try {
      const updated = await runtime.run(runtime.api.setProjectColor(id, choice));
      if (!updated) return;
      runtime.sessionsLoadGeneration++;
      runtime.projects = runtime.projects.map((row) => row.id === id ? updated : row);
      runtime.paintSessions();
    } finally {
      savingProjectColor.delete(id);
    }
  }

  async function removeProjectFromSidebar(id: string): Promise<void> {
    if (removingProject.has(id)) return;
    removingProject.add(id);
    try {
      const removed = await runtime.run(runtime.api.removeProject(id));
      if (!removed) return;
      runtime.sessionsLoadGeneration++;
      runtime.projects = runtime.projects.map((row) => row.id === id ? removed : row);
      runtime.expandedProjects.delete(id);
      runtime.projectVisibleCounts.delete(id);
      if (runtime.selectedProjectId === id) {
        if (!runtime.selectedId) {
          const oldKey = runtime.draftKey();
          const authoredDraft = runtime.authoredComposerText();
          runtime.selectedProjectId = null;
          runtime.selectionGeneration++;
          runtime.replaceComposerDraft();
          runtime.inputDrafts.set(runtime.draftKey(), authoredDraft);
          runtime.inputDrafts.delete(oldKey);
          runtime.newChatTasks.delete(oldKey);
          runtime.restoreSkills();
          const images = runtime.imageDrafts.get(oldKey);
          if (images) runtime.imageDrafts.set(runtime.draftKey(), images);
          else runtime.imageDrafts.delete(runtime.draftKey());
          runtime.imageDrafts.delete(oldKey);
          runtime.ui(runtime.$<HTMLTextAreaElement>('chatInput'), 'placeholder', () => runtime.t('Ask anything…'));
        } else runtime.selectedProjectId = null;
      }
      runtime.paintSessions();
      void runtime.refreshInputQueue();
      runtime.toast(runtime.t('Project removed; conversations kept'));
    } finally {
      removingProject.delete(id);
    }
  }

  function projectColorName(color: ProjectColor): string {
    return {
      blue: runtime.t('Blue'),
      green: runtime.t('Green'),
      amber: runtime.t('Amber'),
      purple: runtime.t('Purple'),
      rose: runtime.t('Rose'),
      teal: runtime.t('Teal')
    }[color];
  }

  function selectedLocalProject(): LocalProject | null {
    if (runtime.selectedId) {
      const selected = runtime.sessions.find((row) => row.id === runtime.selectedId);
      const inherited = selected?.origin?.kind === 'worker' && selected.origin.fromSessionId
        ? runtime.sessions.find((row) => row.id === selected.origin?.fromSessionId)?.projectId
        : undefined;
      const id = selected?.projectId ?? inherited;
      return id ? runtime.projects.find((project) => project.id === id) ?? null : null;
    }
    return runtime.newChatSelected && runtime.selectedProjectId
      ? runtime.projects.find((project) => project.id === runtime.selectedProjectId && !project.ungrouped) ?? null
      : null;
  }

  return { projectGroup, rowMenuButton, projectMenuItems, selectedLocalProject };
}
