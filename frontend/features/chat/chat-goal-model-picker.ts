import type { GoalModel } from '../../../contracts/automation/goal-model-reasoning.js';
import { DEFAULT_GOAL_MODEL } from '../../../contracts/automation/goal-settings.js';
import type { Config } from '../../../contracts/types.js';
import { $, compactNumber, el, run } from '../../shared/dom.js';
import { currentLanguage, t, ui } from '../../shared/i18n.js';
import { renderGoalReasoning } from '../agents/reasoning-selector.js';

const SCROLL_MARGIN = 72;

export interface ChatGoalModelPicker {
  readonly model: string;
  setModel(model: string): void;
  invalidate(): void;
  hasModels(): boolean;
  hasModel(model: string): boolean;
  paint(): void;
  paintReasoning(selected?: Config['goal']['reasoning'], changingModel?: boolean): void;
  load(reset: boolean): Promise<void>;
  wire(onSelect: (model: string) => void): void;
}

export function createChatGoalModelPicker(): ChatGoalModelPicker {
  let modelId = DEFAULT_GOAL_MODEL;
  let models: GoalModel[] = [];
  let selectedModel: GoalModel | undefined;
  let catalogEpoch = 0;
  let total = 0;
  let loading = false;
  let query = '';

  function invalidate(): void {
    catalogEpoch++;
    models = [];
    selectedModel = undefined;
    total = 0;
  }

  function hasModel(id: string): boolean {
    return models.some((candidate) => candidate.id === id) || selectedModel?.id === id;
  }

  function paintReasoning(selected?: Config['goal']['reasoning'], changingModel = false): void {
    const current = models.find((candidate) => candidate.id === modelId) ??
      (selectedModel?.id === modelId ? selectedModel : undefined);
    const custom = $<HTMLSelectElement>('goalProvider').value === 'custom';
    const select = $<HTMLSelectElement>('goalReasoning');
    renderGoalReasoning(
      select,
      custom ? undefined : current,
      custom,
      selected ?? ((select.value || 'default') as Config['goal']['reasoning']),
      changingModel,
    );
  }

  function releaseDate(created: number): string {
    if (!created) return t('release date not published');
    return new Date(created * 1000).toLocaleDateString(currentLanguage(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function paint(): void {
    const list = $('goalModelList');
    const scrollTop = list.scrollTop;
    list.textContent = '';
    for (const candidate of models) {
      const row = el('button', 'goal-model');
      row.setAttribute('type', 'button');
      row.dataset.model = candidate.id;
      if (candidate.id === modelId) row.dataset.chosen = '1';
      row.append(el('b', 'goal-model-name', candidate.name));
      const details = [
        releaseDate(candidate.created),
        candidate.contextLength > 0 ? t('{0} ctx', [compactNumber(candidate.contextLength)]) : '',
      ].filter(Boolean).join(' · ');
      row.append(el('em', 'goal-model-meta', `${candidate.id} · ${details}`));
      list.append(row);
    }
    const count = models.length;
    ui($('goalModelsState'), 'textContent', () => count === 0
      ? t('No models came back.')
      : t('Showing the {0} newest of {1}, newest release first.', [count, total]));
    const more = $<HTMLButtonElement>('goalMore');
    more.disabled = count >= total;
    more.hidden = count >= total;
    list.scrollTop = scrollTop;
    maybeLoadNextPage();
  }

  function maybeLoadNextPage(): void {
    if (loading || models.length === 0 || models.length >= total) return;
    const list = $('goalModelList');
    if (list.clientHeight === 0) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight > SCROLL_MARGIN) return;
    void load(false);
  }

  async function load(reset: boolean): Promise<void> {
    if (reset) invalidate();
    if (loading) return;
    loading = true;
    const requestEpoch = catalogEpoch;
    const requestQuery = query;
    ui($('goalModelsState'), 'textContent', () => t('Loading models…'));
    $<HTMLButtonElement>('goalMore').disabled = true;
    const page = await run(window.api.listGoalModels(models.length, requestQuery));
    loading = false;
    if (requestEpoch !== catalogEpoch || requestQuery !== query) {
      void load(false);
      return;
    }
    if (!page) {
      ui($('goalModelsState'), 'textContent', () => t('The provider could not be reached. The model in use is unchanged.'));
      $<HTMLButtonElement>('goalMore').disabled = models.length === 0;
      return;
    }
    models = [...models, ...page.models];
    selectedModel = page.selectedModel;
    total = page.total;
    paintReasoning();
    paint();
  }

  function wire(onSelect: (model: string) => void): void {
    $('goalPick').addEventListener('click', () => {
      const panel = $('goalModels');
      panel.hidden = !panel.hidden;
      ui($('goalPick'), 'textContent', () => panel.hidden ? t('Select model') : t('Close'));
      if (!panel.hidden && models.length === 0) void load(true);
    });
    const search = $<HTMLInputElement>('goalModelSearch');
    search.maxLength = 160;
    search.addEventListener('input', () => {
      const next = search.value.slice(0, 160);
      if (next === query) return;
      query = next;
      void load(true);
    });
    $('goalMore').addEventListener('click', () => void load(false));
    $('goalReasoning').addEventListener('focus', () => {
      if ($<HTMLSelectElement>('goalProvider').value !== 'custom' && !hasModel(modelId)) void load(true);
    });
    $('goalModelList').addEventListener('scroll', maybeLoadNextPage);
    $('goalModelList').addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
      if (!row?.dataset.model) return;
      modelId = row.dataset.model;
      $('goalModelName').textContent = modelId;
      paintReasoning(undefined, true);
      paint();
      onSelect(modelId);
    });
  }

  return {
    get model() { return modelId; },
    setModel(value) { modelId = value; },
    invalidate,
    hasModels: () => models.length > 0,
    hasModel,
    paint,
    paintReasoning,
    load,
    wire,
  };
}
