import type { SwarmState } from '../../../contracts/session.js';
import { $, run, toast } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

interface ChatAgentEventsRuntime {
  paintSwarm(state: SwarmState): void;
}

export function bindChatAgentEvents(runtime: ChatAgentEventsRuntime): void {
  $('swarmReset').addEventListener('click', async () => {
    if (!window.confirm(t('Clear all workers? Running workers stop, and their saved histories are removed for good. Their provider conversations remain in the account.'))) return;
    const state = await run(window.api.resetSwarm());
    if (!state) return;
    runtime.paintSwarm(state);
    toast(t('Workers cleared'));
  });

  $('swarmList').addEventListener('click', async event => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-clear]');
    const id = button?.dataset.clear;
    if (!id) return;
    const outcome = await run(window.api.clearAgent(id, button.dataset.runId));
    if (!outcome) return;
    runtime.paintSwarm(outcome.swarm);
    toast(
      outcome.cleared === 'run'
        ? t('Run cleared — every worker ended')
        : outcome.cleared === 'worker'
          ? t('{0} cleared — its slot is free', [id])
          : t(outcome.reason)
    );
  });
}
