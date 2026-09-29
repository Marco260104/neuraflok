import { currentLanguage, ui, t } from '../../../shared/i18n.js';
import { $, el } from '../../../shared/dom.js';
import { usageDateKey as dateKey, usageEstimate, usageModelGroups, type UsageFormula, type UsageOverview } from '../../../../contracts/usage.js';

export interface UsageCostViewDependencies {
  snapshot(): UsageOverview | null;
  formula(): UsageFormula;
  count(value: number): string;
  money(value: number): string;
  usageHint(node: HTMLElement, text: string | (() => string)): void;
}

type EstimatedUsageDay = UsageOverview['days'][number] & ReturnType<typeof usageEstimate>;

function dayLabel(key: string): string {
  const date = new Date(`${key}T00:00:00`);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString(currentLanguage(), { weekday: 'short', month: 'short', day: 'numeric' });
}

export function createUsageCostView(dependencies: UsageCostViewDependencies): { paint(): void } {
  function paintHeatmap(daily: EstimatedUsageDay[], snapshot: UsageOverview): void {
    const heat = $('usageHeatmap');
    heat.replaceChildren();
    const byDay = new Map(daily.map(day => [day.date, day.tokens]));
    const peak = Math.max(1, ...daily.map(day => day.tokens));
    const weeks = 52;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (today.getDay() + 6) % 7 - (weeks - 1) * 7);
    const grid = el('div', 'heat-grid');
    grid.setAttribute('role', 'group');
    grid.style.gridTemplateColumns = `var(--heat-label) repeat(${weeks}, minmax(0, 1fr))`;
    const place = (node: HTMLElement, row: number, column: string) => {
      node.style.gridRow = String(row);
      node.style.gridColumn = column;
      grid.append(node);
    };
    for (let row = 0; row < 7; row += 1) {
      const label = el('span', 'heat-day');
      label.setAttribute('aria-hidden', 'true');
      if (row % 2 === 0) ui(label, 'textContent', () => new Date(2026, 8, 21 + row).toLocaleDateString(currentLanguage(), { weekday: 'short' }));
      place(label, row + 2, '1');
    }
    const ordinal = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
    for (let offset = 11; offset >= 0; offset -= 1) {
      const date = new Date(today.getFullYear(), today.getMonth() - offset, 1);
      const week = Math.max(0, Math.floor((ordinal(date) - ordinal(start)) / 7));
      const month = el('span', 'heat-month');
      month.setAttribute('aria-hidden', 'true');
      ui(month, 'textContent', () => date.toLocaleDateString(currentLanguage(), { month: 'short' }));
      const column = Math.min(week, weeks - 3);
      if (column !== week) month.classList.add('is-end');
      place(month, 1, `${column + 2} / span 3`);
    }
    for (let week = 0; week < weeks; week += 1) {
      const monday = new Date(start);
      monday.setDate(start.getDate() + week * 7);
      for (let row = 0; row < 7; row += 1) {
        const date = new Date(monday);
        date.setDate(monday.getDate() + row);
        if (date > today) {
          place(el('span', 'heat-cell is-future'), row + 2, String(week + 2));
          continue;
        }
        const key = dateKey(date);
        const tokens = byDay.get(key) ?? 0;
        const cell = el('span', 'heat-cell');
        cell.dataset.level = String(tokens ? Math.max(1, Math.ceil(tokens / peak * 4)) : 0);
        const hint = () => t('{0}: {1} estimated tokens', [dayLabel(key), Math.round(tokens).toLocaleString(currentLanguage())]);
        dependencies.usageHint(cell, hint);
        ui(cell, 'aria-label', hint);
        place(cell, row + 2, String(week + 2));
      }
    }
    const legend = el('div', 'heat-legend');
    legend.setAttribute('aria-hidden', 'true');
    legend.append(el('span', '', () => t('Less')));
    for (let level = 0; level <= 4; level += 1) {
      const swatch = el('span', 'heat-cell');
      swatch.dataset.level = String(level);
      legend.append(swatch);
    }
    legend.append(el('span', '', () => t('More')));
    heat.append(grid, legend);
    setTimeout(() => {
      const box = heat.parentElement;
      if (box && box.scrollWidth > box.clientWidth) box.scrollLeft = box.scrollWidth;
    }, 0);
    ui($('usageHeatmapCaption'), 'textContent', () => t('Estimated context processed per tool call · last 52 weeks'));
    const formula = dependencies.formula();
    ui($('usageFormula'), 'textContent', () => t('Final frontend context (capped at {2} tokens for this estimate) × unique tool calls ÷ {0} × each model’s cached-input rate ÷ 1M × {1}.', [formula.divisor, formula.multiplier, snapshot.contextTokenCap.toLocaleString(currentLanguage())]));
  }

  function paintModelTable(snapshot: UsageOverview, formula: UsageFormula, costText: (estimate: ReturnType<typeof usageEstimate>) => string): HTMLElement {
    const table = el('table', 'usage-table');
    const header = el('tr');
    for (const title of ['Recorded model / effort', 'Estimated tokens', 'Estimated equivalent']) header.append(el('th', '', () => t(title)));
    table.append(header);
    for (const entry of usageModelGroups(snapshot.models)) {
      const estimate = usageEstimate(entry.sources, formula);
      const row = el('tr');
      const name = el('td', '', () => `${entry.model} · ${entry.reasoningEffort ?? t('effort unknown')}${entry.assumed ? t(' (assumed)') : ''}`);
      dependencies.usageHint(name, () => t('Recorded IDs: {0}', [[...new Set(entry.sources.map(source => source.model))].join(', ')]));
      const equivalent = estimate.unpricedTokens > 0 && estimate.unpricedTokens === estimate.tokens ? t('Rate unknown') : costText(estimate);
      row.append(name, el('td', '', () => Math.round(estimate.tokens).toLocaleString(currentLanguage())), el('td', '', () => equivalent));
      table.append(row);
    }
    return table;
  }

  function paintDailyView(daily: EstimatedUsageDay[], snapshot: UsageOverview, formula: UsageFormula, costText: (estimate: ReturnType<typeof usageEstimate>) => string): HTMLElement {
    const recent = daily.slice(-30);
    const chart = el('div', 'usage-bars');
    chart.setAttribute('role', 'img');
    ui(chart, 'aria-label', () => t('Estimated cost per day, last {0} days', [recent.length]));
    const top = Math.max(0, ...recent.map(day => day.cost));
    const peakDay = recent.find(day => day.cost === top);
    for (const day of recent) {
      const bar = el('span', 'usage-bar');
      bar.style.height = `${top > 0 ? Math.max(2, Math.round(day.cost / top * 100)) : 2}%`;
      if (day.cost === top && top > 0) bar.classList.add('is-peak');
      dependencies.usageHint(bar, () => `${dayLabel(day.date)} · ${costText(day)} · ${t('{0} estimated tokens', [Math.round(day.tokens).toLocaleString(currentLanguage())])}`);
      chart.append(bar);
    }
    const scale = el('div', 'usage-bars-scale', () => peakDay ? costText(peakDay) : dependencies.money(top));
    const axis = el('div', 'usage-bars-axis');
    if (recent.length) axis.append(el('span', '', () => dayLabel(recent[0]!.date)), el('span', '', () => dayLabel(recent[recent.length - 1]!.date)));
    const breakdown = el('details', 'usage-breakdown');
    breakdown.append(el('summary', '', () => t('Daily breakdown')));
    const table = el('table', 'usage-table');
    const header = el('tr');
    header.append(el('th', '', () => t('Day')), el('th', '', () => t('Estimated tokens')), el('th', '', () => t('Cached × {0}', [formula.multiplier])));
    table.append(header);
    for (const day of [...daily].reverse()) {
      const row = el('tr');
      row.append(el('td', '', () => dayLabel(day.date)), el('td', '', () => Math.round(day.tokens).toLocaleString(currentLanguage())), el('td', '', () => costText(day)));
      table.append(row);
    }
    if (!snapshot.days.length) {
      const row = el('tr');
      const cell = el('td', 'muted', () => t('No recorded tool calls yet.'));
      cell.setAttribute('colspan', '3');
      row.append(cell);
      table.append(row);
    }
    breakdown.append(table);
    const section = el('section', 'usage-days-daily');
    section.append(el('h3', 'usage-cost-subhead', () => t('By day')));
    if (recent.length) section.append(scale, chart, axis);
    section.append(breakdown);
    return section;
  }

  function paint(): void {
    const snapshot = dependencies.snapshot();
    if (!snapshot) return;
    const formula = dependencies.formula();
    const total = usageEstimate(snapshot.models, formula);
    const costText = (estimate: ReturnType<typeof usageEstimate>) => estimate.unpricedTokens > 0 ? `≥ ${dependencies.money(estimate.cost)}` : dependencies.money(estimate.cost);
    const costSummary = document.getElementById('usageTotalCost');
    if (costSummary) {
      ui(costSummary.querySelector('strong')!, 'textContent', () => costText(total));
      ui(costSummary, 'data-usage-hint', () => t('{0} estimated tokens; {1} have no comparison rate. Cached-input equivalent, not a bill.', [Math.round(total.tokens).toLocaleString(currentLanguage()), Math.round(total.unpricedTokens).toLocaleString(currentLanguage())]));
    }
    const daily = snapshot.days.map(day => ({ ...day, ...usageEstimate(day.models, formula) }));
    for (const [label, number] of [['Processed tokens · est.', total.tokens], ['Peak daily tokens', Math.max(0, ...daily.map(day => day.tokens))]] as const) {
      const item = [...$('usageSummary').children].find(node => (node as HTMLElement).dataset.usageMetric === label) as HTMLElement | undefined;
      if (item) {
        ui(item.querySelector('strong')!, 'textContent', () => dependencies.count(number));
        ui(item, 'data-usage-hint', () => `${Math.round(number).toLocaleString(currentLanguage())} ${t(label).toLowerCase()}`);
      }
    }
    paintHeatmap(daily, snapshot);
    ui($('usageCost'), 'textContent', () => t('{0} estimated equivalent. {1}This is a comparison, not a bill.', [costText(total), total.unpricedTokens ? t('{0} tokens have no rate. ', [Math.round(total.unpricedTokens).toLocaleString(currentLanguage())]) : '']));
    const modelSection = el('section', 'usage-days-model');
    modelSection.append(el('h3', 'usage-cost-subhead', () => t('By model')), paintModelTable(snapshot, formula, costText));
    $('usageDays').replaceChildren(modelSection, paintDailyView(daily, snapshot, formula, costText));
  }

  return { paint };
}
