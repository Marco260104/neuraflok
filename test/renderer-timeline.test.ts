import { vi } from 'vitest';
import './renderer-timeline/timeline-session-navigation.js';
import './renderer-timeline/composer-attachments-and-images.js';
import './renderer-timeline/project-sidebar-and-work-state.js';
import './renderer-timeline/compaction-and-chat-actions.js';
import './renderer-timeline/summary-and-plan-dock.js';
import './renderer-timeline/goal-delivery-and-progress.js';
import './renderer-timeline/composer-and-task-lifecycle.js';
import './renderer-timeline/history-reading-and-timeline.js';
import './renderer-timeline/rounds-and-reader-gestures.js';

vi.mock('../frontend/features/workspace/terminal/composition.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), hasTabs: () => false,
  tabs: () => [], newTab: () => null, selectTab: vi.fn(), closeTab: vi.fn()
}) }));

vi.mock('../frontend/features/workspace/editors/diff-viewer.js', () => ({
  createProjectDiffViewer: async ({ parent, baseText, currentText }: { parent: HTMLElement; baseText: string; currentText: string }) => {
    const view = parent.ownerDocument.createElement('pre');
    view.textContent = `${baseText}\n---\n${currentText}`;
    parent.append(view);
    return { destroy: () => view.remove(), language: 'TypeScript' };
  }
}));
