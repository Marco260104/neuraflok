import { currentLanguage, ui, t } from '../../shared/i18n.js';
import { $, el, run } from '../../shared/dom.js';
import { DEFAULT_USAGE_FORMULA, usageMessageTotals, usageRate, usageWeekStart, type UsageFormula, type UsageOverview } from '../../../contracts/usage.js';
import { createUsageCostView } from './usage/cost-view.js';
let snapshot: UsageOverview | null = null;
let loadGeneration = 0;
const FORMULA_KEY = 'neuraflok.usage.formula.v2';
const WEEK_START_KEY = 'neuraflok.usage.weekStart';
let weekStart = 1;
let formula: UsageFormula = { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates } };
function saveFormula(): void {
  try { localStorage.setItem(FORMULA_KEY, JSON.stringify(formula)); } catch { /* Read-only storage still permits an in-memory comparison. */ }
}

// Format numbers in the selected app language and keep estimated token counts whole.
const count = { format: (value: number) => new Intl.NumberFormat(currentLanguage(), { notation: 'compact', maximumFractionDigits: 1 }).format(Math.round(value)) };
const money = { format: (value: number) => new Intl.NumberFormat(currentLanguage(), { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value) };
function usageHint(node: HTMLElement, text: string | (() => string)): void {
  ui(node, 'data-usage-hint', typeof text === 'function' ? text : () => text);
  node.setAttribute('tabindex', '0');
  const hide = () => document.getElementById('usageTooltip')?.remove();
  const show = () => {
    hide();
    const tip = el('div', 'session-tooltip', node.dataset.usageHint ?? ''); tip.id = 'usageTooltip'; tip.setAttribute('role', 'tooltip');
    const bounds = node.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 290))}px`;
    tip.style.top = `${Math.max(8, bounds.top - 64)}px`;
    document.body.append(tip);
  };
  node.addEventListener('pointerenter', show); node.addEventListener('pointerleave', hide);
  node.addEventListener('focus', show); node.addEventListener('blur', hide);
  node.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
}
// Format weekday names with the selected app language.
function weekdayName(weekday: number): string {
  return new Date(2026, 8, 20 + (weekday === 0 ? 7 : weekday)).toLocaleDateString(currentLanguage(), { weekday: 'long' });
}
const costView = createUsageCostView({ snapshot: () => snapshot, formula: () => formula, count: value => count.format(value), money: value => money.format(value), usageHint });
function paintCost(): void { costView.paint(); }

function paintMessages(): void {
  const through = snapshot?.messages.through ?? Date.now();
  const from = usageWeekStart(weekStart, through);
  const select = $<HTMLSelectElement>('usageWeekStart');
  select.value = String(weekStart);
  if (!snapshot) return;
  const totals = usageMessageTotals(snapshot.messages, weekStart);
  ui($('usageMessages'), 'textContent', () => totals.sent.toLocaleString(currentLanguage()));
  const period = () => {
    const format = new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'short', timeStyle: 'short' });
    return t('Local time · {0} → {1}', [format.format(from), format.format(through)]);
  };
  ui($('usageMessagePeriod'), 'textContent', period);
  ui(select, 'title', () => `${t('Change start day')}\n${period()}`);
}
export async function refreshUsage(): Promise<void> {
  document.getElementById('usageTooltip')?.remove();
  const generation = ++loadGeneration;
  $('refreshUsage').setAttribute('disabled', '');
  const status = $('usageStatus');
  ui(status, 'textContent', () => t("Updating usage in the background. After an update, this can take a few minutes. You can keep using the app."));
  status.setAttribute('role', 'status');
  try {
    const value = await run(window.api.getUsage());
    if (generation !== loadGeneration) return;
    if (!value) { ui(status, 'textContent', () => t("Usage could not be loaded. Try Refresh.")); return; }
    snapshot = value;
    paintMessages();
    const summary = $('usageSummary'); summary.replaceChildren();
    for (const [label, number] of [['Processed tokens · est.', value.tokens], ['Peak daily tokens', Math.max(0, ...value.days.map((day) => day.tokens))], ['Conversations', value.sessions], ['Active days', value.days.filter((day) => day.tokens > 0).length]] as const) {
      const item = el('div'); item.dataset.usageMetric = label; usageHint(item, () => `${Math.round(number).toLocaleString(currentLanguage())} ${t(label).toLowerCase()}`); item.append(el('strong', '', () => count.format(number)), el('span', '', () => t(label))); summary.append(item);
    }
    const totalCost = el('div'); totalCost.append(el('strong', '', '—'), el('span', '', () => t("Estimated equivalent · USD"))); totalCost.id = 'usageTotalCost'; usageHint(totalCost, ''); summary.prepend(totalCost);
    paintRates();
    paintCost();
    ui(status, 'textContent', () => '');
  } catch {
    if (generation === loadGeneration) ui(status, 'textContent', () => t("Usage could not be loaded. Try Refresh."));
  } finally { if (generation === loadGeneration) $('refreshUsage').removeAttribute('disabled'); }
}
function paintRates(): void {
  if (!snapshot) return;
  const host = $('usageRates'); host.replaceChildren();
  for (const model of [...new Set(snapshot.models.map(row => row.model))].sort()) {
    const label = el('label', 'setting'); const text = el('span', 'setting-text');
    text.append(el('b', '', model), el('em', '', () => t("USD / 1M cached input · enter a verified comparison rate")));
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.step = '0.01'; ui(input, 'placeholder', () => t("Unknown rate")); input.value = usageRate(model, formula)?.toString() ?? '';
    ui(input, 'aria-label', () => t("{0} cached-input USD per million tokens", [model]));
    input.addEventListener('input', () => {
      if (input.value === '') formula.rates[model] = null;
      else if (input.validity.valid && Number.isFinite(input.valueAsNumber)) formula.rates[model] = input.valueAsNumber;
      else return;
      saveFormula(); paintCost();
    });
    label.append(text, input); host.append(label);
  }
}
export function initUsage(): void {
  try {
    const saved = localStorage.getItem(WEEK_START_KEY);
    if (saved !== null && /^[0-6]$/.test(saved)) weekStart = Number(saved);
  } catch { /* The weekday can still be changed in this window. */ }
  // Let users choose any weekday as the reporting period start.
  const select = $<HTMLSelectElement>('usageWeekStart');
  select.replaceChildren();
  for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
    const option = document.createElement('option'); option.value = String(weekday);
    ui(option, 'textContent', () => t('Since {0}', [weekdayName(weekday)]));
    select.append(option);
  }
  ui(select, 'aria-label', () => t('Change start day'));
  paintMessages();
  usageHint($('usageMessagesTitle'), () => t('Counts recorded messages from supported provider and API conversations.'));
  select.addEventListener('change', () => {
    const next = Number(select.value);
    if (!Number.isInteger(next) || next < 0 || next > 6) return;
    weekStart = next;
    try { localStorage.setItem(WEEK_START_KEY, String(weekStart)); } catch { /* Keep the current in-memory choice. */ }
    paintMessages();
  });
  try {
    const saved = JSON.parse(localStorage.getItem(FORMULA_KEY) ?? 'null');
    if (saved && Number.isFinite(saved.divisor) && saved.divisor > 0 && Number.isFinite(saved.multiplier) && saved.multiplier >= 0 && saved.rates && typeof saved.rates === 'object' && !Array.isArray(saved.rates)) {
      formula = { divisor: saved.divisor, multiplier: saved.multiplier, rates: { ...DEFAULT_USAGE_FORMULA.rates, ...Object.fromEntries(Object.entries(saved.rates).filter(([key, value]) => key.length <= 100 && (value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0))) } as UsageFormula['rates'] };
    }
  } catch { /* Invalid display preferences use the documented default. */ }
  for (const [key, id] of [['divisor', 'usageDivisor'], ['multiplier', 'usageMultiplier']] as const) {
    const input = $<HTMLInputElement>(id); input.value = String(formula[key]);
    input.addEventListener('input', () => { if (input.value !== '' && input.validity.valid && Number.isFinite(input.valueAsNumber)) { formula[key] = input.valueAsNumber; saveFormula(); paintCost(); } });
  }
  $('refreshUsage').addEventListener('click', () => void refreshUsage());
}
