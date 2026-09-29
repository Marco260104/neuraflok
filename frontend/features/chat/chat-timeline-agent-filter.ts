import type { SessionEvent } from '../../../contracts/session.js';
import type { AppState } from '../../../contracts/types.js';
import { $ } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

export interface ChatTimelineAgentFilterRuntime {
  events: SessionEvent[];
  selectedId: string | null;
  agentFilter: string | null;
  filterFor: string | null;
  UNATTRIBUTED: string;
  state: () => AppState | null;
}

export function createChatTimelineAgentFilter(runtime: ChatTimelineAgentFilterRuntime) {
  // Shows agent filters only when a timeline has multiple attribution groups.
  function paintAgentFilter(): void {
    const box = $('chatAgentFilter');
    if (!runtime.state()?.config.ui.developerMode) {
      box.hidden = true;
      runtime.agentFilter = null;
      return;
    }
    const named = [
      ...new Set(
        runtime.events.flatMap((event) => (event.agent ? [event.agent] : [])),
      ),
    ].sort();
    const anyUnattributed = runtime.events.some((event) => !event.agent);
    // Reset a filter when its session changes or its agent disappears.
    if (runtime.filterFor !== runtime.selectedId) {
      runtime.agentFilter = null;
      runtime.filterFor = runtime.selectedId;
    } else if (
      runtime.agentFilter !== null &&
      runtime.agentFilter !== runtime.UNATTRIBUTED &&
      !named.includes(runtime.agentFilter)
    ) {
      runtime.agentFilter = null;
    }
    if (named.length === 0 || (named.length === 1 && !anyUnattributed)) {
      box.hidden = true;
      box.replaceChildren();
      runtime.agentFilter = null;
      return;
    }
    const buttons: HTMLElement[] = [];
    const chip = (value: string | null, label: string): HTMLElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.agent = value ?? '';
      if (runtime.agentFilter === value) button.classList.add('is-sel');
      return button;
    };
    buttons.push(chip(null, t('All')));
    for (const agent of named) buttons.push(chip(agent, agent));
    if (anyUnattributed)
      buttons.push(chip(runtime.UNATTRIBUTED, t('Unattributed')));
    box.replaceChildren(...buttons);
    box.hidden = false;
  }

  function visibleEvents(): SessionEvent[] {
    if (runtime.agentFilter === null) return runtime.events;
    if (runtime.agentFilter === runtime.UNATTRIBUTED)
      return runtime.events.filter((event) => !event.agent);
    return runtime.events.filter(
      (event) => event.agent === runtime.agentFilter,
    );
  }

  return { paintAgentFilter, visibleEvents };
}
