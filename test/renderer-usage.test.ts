import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { UsageOverview } from '../contracts/usage.js';

let dom: JSDOM;
// The renderer formats money and compact counts in the selected app language.
const money = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usd = (value: number) => money.format(value);
afterEach(() => { dom?.window.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it('chooses the week start from a weekday menu, keeps exact counts, and restores the weekday after reload', async () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const data: UsageOverview = { contextTokenCap: 256_000, tokens: 0, models: [], days: [], sessions: 1,
    messages: { through: new Date(2026, 8, 21, 12).getTime(), days: [
      { date: '2026-09-19', sent: 1234 }, { date: '2026-09-20', sent: 10 }, { date: '2026-09-21', sent: 1 }
    ] } };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage } });
  const { initLanguage, setLanguage } = await import('../frontend/shared/i18n.js'); initLanguage();
  const usage = await import('../frontend/features/settings/usage.js'); usage.initUsage();
  const element = (id: string) => dom.window.document.getElementById(id)!;
  const select = element('usageWeekStart') as HTMLSelectElement;
  const surface = select.closest('.usage-message-surface')!;
  expect(element('usageMessageCounts').parentElement).toBe(surface);
  expect(element('refreshUsage').closest('.settings-section-head')).not.toBeNull();
  expect(surface.contains(element('refreshUsage'))).toBe(false);
  const chosen = () => select.selectedOptions[0]!.textContent;
  const choose = (weekday: number) => { select.value = String(weekday); select.dispatchEvent(new dom.window.Event('change')); };
  // Show all seven named weekday choices with Monday first.
  expect([...select.options].map(option => option.value)).toEqual(['1', '2', '3', '4', '5', '6', '0']);
  expect(select.options[6]!.textContent).toBe('Since Sunday');
  expect(element('usageMessages').textContent).toBe('—');
  await usage.refreshUsage();
  expect(chosen()).toBe('Since Monday');
  expect(element('usageMessages').textContent).toBe('1');
  expect(element('usageStatus').textContent).toBe('');
  expect(element('usageMessageCounts').textContent).toContain('sent');
  expect(element('usageMessageCounts').textContent).not.toContain('remaining');
  choose(6);
  expect(chosen()).toBe('Since Saturday');
  expect(element('usageMessages').textContent).toBe((1245).toLocaleString('en'));
  expect(element('usageMessagePeriod').textContent).toContain(new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(2026, 8, 19)));
  expect(select.title).toContain(element('usageMessagePeriod').textContent);
  expect(dom.window.localStorage.getItem('neuraflok.usage.weekStart')).toBe('6');
  expect(getUsage).toHaveBeenCalledTimes(1);
  setLanguage('ja');
  expect(element('usageWeekStart')).toBe(select);
  expect(chosen()).toContain('土曜日から');
  expect(element('usageMessages').textContent).toBe((1245).toLocaleString('en'));
  setLanguage('en');
  choose(0);
  expect(chosen()).toBe('Since Sunday');
  expect(element('usageMessages').textContent).toBe('11');
  choose(1);
  expect(element('usageMessages').textContent).toBe('1');
  expect(getUsage).toHaveBeenCalledTimes(1);
  dom.window.localStorage.setItem('neuraflok.usage.weekStart', '6');
  vi.resetModules();
  const restored = await import('../frontend/features/settings/usage.js'); restored.initUsage(); await restored.refreshUsage();
  expect((element('usageWeekStart') as HTMLSelectElement).value).toBe('6');
  expect(element('usageMessages').textContent).toBe((1245).toLocaleString('en'));
  expect(element('usageStatus').textContent).toBe('');
});

it.each(['7', '-1', '1.5', 'invalid', ''])('ignores invalid persisted weekday %j', async saved => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  dom.window.localStorage.setItem('neuraflok.usage.weekStart', saved);
  const { initUsage } = await import('../frontend/features/settings/usage.js'); initUsage();
  expect((dom.window.document.getElementById('usageWeekStart') as HTMLSelectElement).value).toBe('1');
  expect(dom.window.document.getElementById('usageMessages')!.textContent).toBe('—');
});

it('explains a pending background rebuild and replaces transport failure with a retryable status', async () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let reject!: (error: Error) => void;
  Object.assign(dom.window, { api: {
    getUsage: () => new Promise((_resolve, fail) => { reject = fail; }),
  } });
  const { refreshUsage } = await import('../frontend/features/settings/usage.js');
  const pending = refreshUsage();
  const status = dom.window.document.getElementById('usageStatus')!;
  const refresh = dom.window.document.getElementById('refreshUsage') as HTMLButtonElement;
  expect(status.textContent).toContain('You can keep using the app.');
  expect(refresh.disabled).toBe(true);
  reject(new Error('IPC disconnected'));
  await pending;
  expect(status.textContent).toBe('Usage could not be loaded. Try Refresh.');
  expect(refresh.disabled).toBe(false);
});

it('shows the provider-neutral context cap and edits formula preferences without reloading recordings', async () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [
    { model: 'unknown', reasoningEffort: null, assumed: true, tokens: 1e6 },
    { model: 'another-model', reasoningEffort: 'low', assumed: false, tokens: 1e6 }
  ];
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 2e6, models, days: [{ date: '2026-09-05', tokens: 2e6, models }], sessions: 1 };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage } });
  const { initUsage, refreshUsage } = await import('../frontend/features/settings/usage.js');
  const field = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  const change = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  const cost = () => dom.window.document.getElementById('usageTotalCost')!.textContent;
  const divisor = field('usageDivisor');
  initUsage(); await refreshUsage();
  expect(dom.window.document.getElementById('usageFormula')!.textContent).toContain('capped at 256,000 tokens');
  const formulaDetails = dom.window.document.getElementById('usageFormulaDetails') as HTMLDetailsElement;
  expect(formulaDetails.open).toBe(false);
  expect(divisor.closest('details')).toBe(formulaDetails);
  expect(dom.window.document.getElementById('usageRates')!.closest('details')).toBe(formulaDetails);
  expect(dom.window.document.getElementById('usageDays')!.closest('details')).toBeNull();
  expect(dom.window.document.getElementById('usageTotalCost')!.closest('details')).toBeNull();
  formulaDetails.querySelector('summary')!.click();
  expect(formulaDetails.open).toBe(true);
  expect(field('usageDivisor')).toBe(divisor);
  expect(dom.window.document.getElementById('costModel')).toBeNull();
  expect(cost()).toContain(`≥ ${usd(0)}`);
  change(divisor, '4');
  expect(cost()).toContain(`≥ ${usd(0)}`);
  expect(dom.window.document.getElementById('usageFormula')!.textContent).toContain('÷ 4');
  formulaDetails.querySelector('summary')!.click();
  expect(formulaDetails.open).toBe(false);
  expect(cost()).toContain(`≥ ${usd(0)}`);
  change(divisor, '0'); // Invalid edits do not corrupt the active calculation.
  expect(cost()).toContain(`≥ ${usd(0)}`);
  const unknownRate = dom.window.document.querySelector('input[aria-label="another-model cached-input USD per million tokens"]') as HTMLInputElement;
  change(unknownRate, '1');
  expect(cost()).toContain(usd(0.60)); expect(cost()).toContain('≥');
  change(field('usageMultiplier'), '1');
  expect(cost()).toContain(usd(0.50));
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(JSON.parse(dom.window.localStorage.getItem('neuraflok.usage.formula.v2')!)).toMatchObject({ divisor: 4, multiplier: 1, rates: { 'another-model': 1 } });
  vi.resetModules();
  const restored = await import('../frontend/features/settings/usage.js');
  restored.initUsage(); await restored.refreshUsage();
  expect(field('usageDivisor').value).toBe('4'); expect(field('usageMultiplier').value).toBe('1');
  expect(cost()).toContain(usd(0.50));
});

it('lets users price an exact provider model and preserves a cleared rate after reload', async () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [{ model: 'deepseek-chat', reasoningEffort: null, assumed: false, tokens: 427245 }];
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 427245, models, days: [{ date: '2026-09-07', tokens: 427245, models }], sessions: 1 };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage } });
  const usage = await import('../frontend/features/settings/usage.js');
  usage.initUsage(); await usage.refreshUsage();
  const rate = () => dom.window.document.querySelector('input[aria-label="deepseek-chat cached-input USD per million tokens"]') as HTMLInputElement;
  expect(rate().value).toBe('');
  expect(dom.window.document.getElementById('usageDays')!.textContent).toContain('Rate unknown');
  rate().value = '0.4'; rate().dispatchEvent(new dom.window.Event('input'));
  expect(dom.window.document.getElementById('usageTotalCost')!.textContent).toContain(usd(0.21));
  rate().value = ''; rate().dispatchEvent(new dom.window.Event('input'));
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(dom.window.document.getElementById('usageDays')!.textContent).toContain('Rate unknown');
  vi.resetModules();
  const restored = await import('../frontend/features/settings/usage.js');
  restored.initUsage(); await restored.refreshUsage();
  expect(rate().value).toBe('');
  expect(dom.window.document.getElementById('usageDays')!.textContent).toContain('Rate unknown');
});

it('keeps provider model identifiers separate and applies a manual rate to only that model', async () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = ['deepseek-chat', 'deepseek-reasoner', 'kimi-k2'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 }));
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 3e6, models, days: [{ date: '2026-09-08', tokens: 3e6, models }], sessions: 1 };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage } });
  const usage = await import('../frontend/features/settings/usage.js'); usage.initUsage(); await usage.refreshUsage();
  const table = () => dom.window.document.querySelector('#usageDays table')!;
  expect(table().querySelectorAll('tr')).toHaveLength(4);
  expect(table().textContent).toContain('deepseek-chat · high');
  expect(table().textContent).toContain('deepseek-reasoner · high');
  expect(table().textContent).toContain('kimi-k2 · high');
  expect(table().textContent).toContain('Rate unknown');
  expect(dom.window.document.querySelectorAll('#usageRates input')).toHaveLength(3);
  const rate = dom.window.document.querySelector('input[aria-label="deepseek-chat cached-input USD per million tokens"]') as HTMLInputElement;
  rate.value = '0.8'; rate.dispatchEvent(new dom.window.Event('input'));
  expect(table().textContent).toContain(usd(0.96));
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(models[0]!.model).toBe('deepseek-chat');
});

it.each(['2026-09-28', '2026-10-01', '2027-01-01', '2028-02-29'])('draws an annual Monday-first calendar ending %s, with twelve month labels and a legend', async date => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${date}T12:00:00`));
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  dom.window.localStorage.setItem('neuraflok.usage.formula.v2', JSON.stringify({ divisor: 2, multiplier: 1.2, rates: { 'qwen-plus': 0.4 } }));
  const key = (ago: number) => { const date = new Date(); date.setDate(date.getDate() - ago); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  const models = [{ model: 'qwen-plus', reasoningEffort: 'high', assumed: false, tokens: 1e6 }];
  const days = [{ date: key(3), tokens: 1e6, models }, { date: key(0), tokens: 4e6, models: [{ ...models[0]!, tokens: 4e6 }] }]; // Oldest first, as the main process sends them.
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 5e6, models, days, sessions: 1 };
  Object.assign(dom.window, { api: { getUsage: async () => ({ ok: true, data }) } });
  const usage = await import('../frontend/features/settings/usage.js'); usage.initUsage(); await usage.refreshUsage();
  const heat = dom.window.document.getElementById('usageHeatmap')!;
  const cells = [...heat.querySelectorAll('.heat-grid > .heat-cell')] as HTMLElement[];
  // Keep the full annual window when only two activity days exist.
  expect(cells).toHaveLength(52 * 7);
  const todayRow = (new Date().getDay() + 6) % 7;
  const today = cells[51 * 7 + todayRow]!;
  expect(today.dataset.level).toBe('4');
  expect(cells.slice(51 * 7 + todayRow + 1).every(cell => cell.classList.contains('is-future'))).toBe(true);
  expect(cells.filter(cell => cell.dataset.level && cell.dataset.level !== '0')).toHaveLength(2);
  const cellAt = (cell: HTMLElement) => [cell.style.gridRow, cell.style.gridColumn];
  expect(cellAt(today)).toEqual([String(todayRow + 2), '53']);
  // Keep sticky weekday labels and name every other day.
  expect([...heat.querySelectorAll('.heat-day')].map(label => label.textContent)).toEqual(['Mon', '', 'Wed', '', 'Fri', '', 'Sun']);
  expect(heat.querySelectorAll('.heat-month')).toHaveLength(12);
  expect(new Set([...heat.querySelectorAll('.heat-month')].map(label => label.textContent)).size).toBe(12);
  expect(heat.querySelector('.heat-legend')!.textContent).toBe('LessMore');
  // Show the chart peak, date range, and newest daily row.
  const todayCost = dom.window.document.querySelector('.usage-breakdown tr:nth-child(2) td:last-child')!.textContent;
  expect(dom.window.document.querySelector('.usage-bars-scale')!.textContent).toBe(todayCost);
  expect(dom.window.document.querySelectorAll('.usage-bar.is-peak')).toHaveLength(1);
  expect(dom.window.document.querySelectorAll('.usage-bars-axis > span')).toHaveLength(2);
});

it('prints totals and amounts in the app language and follows a language change', async () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [{ model: 'qwen-plus', reasoningEffort: 'high', assumed: false, tokens: 8.5e9 }];
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 8.5e9, models, days: [{ date: '2026-09-08', tokens: 8.5e9, models }], sessions: 1 };
  Object.assign(dom.window, { api: { getUsage: vi.fn(async () => ({ ok: true, data })) } });
  const { initUsage, refreshUsage } = await import('../frontend/features/settings/usage.js');
  const { setLanguage } = await import('../frontend/shared/i18n.js');
  initUsage(); await refreshUsage();
  const processed = () => dom.window.document.querySelector('[data-usage-metric="Processed tokens · est."] strong')!.textContent;
  const cost = () => dom.window.document.querySelector('#usageTotalCost strong')!.textContent;
  const compact = (language: string) => new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(8.5e9);
  expect(processed()).toBe(compact('en'));
  const englishCost = cost();
  setLanguage('de');
  expect(processed()).toBe(compact('de'));
  expect(cost()).not.toBe(englishCost);
  expect(cost()).toMatch(/\$/);
  setLanguage('en');
  expect(processed()).toBe(compact('en'));
});

// Keep displayed token counts whole in every supported language.
it('prints estimated token counts as whole numbers where compact notation keeps the thousands', async () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [{ model: 'qwen-plus', reasoningEffort: 'high', assumed: false, tokens: 307_373.5 }];
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 307_373.5, models, days: [{ date: '2026-10-08', tokens: 307_373.5, models }], sessions: 1 };
  Object.assign(dom.window, { api: { getUsage: vi.fn(async () => ({ ok: true, data })) } });
  const { initUsage, refreshUsage } = await import('../frontend/features/settings/usage.js');
  const { setLanguage } = await import('../frontend/shared/i18n.js');
  initUsage(); await refreshUsage();
  const peak = () => dom.window.document.querySelector('[data-usage-metric="Peak daily tokens"] strong')!.textContent;
  setLanguage('de');
  expect(peak()).toBe('307.374');
  setLanguage('en');
  expect(peak()).toBe('307.4K');
});
