import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_USAGE_FORMULA, usageMessageTotals, usageModelGroups, usageRate, usageWeekStart } from '../contracts/usage.js';

afterEach(() => vi.unstubAllEnvs());

it('selects each most recent weekday, including today, across the year boundary', () => {
  const through = new Date(2027, 0, 4, 12).getTime();
  for (const [weekday, day] of [[0, 3], [1, 4], [2, -2], [3, -1], [4, 0], [5, 1], [6, 2]]) {
    expect(usageWeekStart(weekday!, through)).toBe(new Date(2027, 0, day!, 0, 0, 0, 0).getTime());
  }
});

it.each([
  ['Europe/Berlin', '2026-03-30T12:00:00', '2026-03-27T23:00:00.000Z', 59],
  ['Europe/Berlin', '2026-10-26T12:00:00', '2026-10-23T22:00:00.000Z', 61],
  ['America/New_York', '2026-03-09T12:00:00', '2026-03-07T05:00:00.000Z', 59],
  ['America/New_York', '2026-11-02T12:00:00', '2026-10-31T04:00:00.000Z', 61]
])('keeps Saturday at local midnight in %s across %s', (zone, localMonday, expectedUTC, hours) => {
  vi.stubEnv('TZ', zone);
  const through = new Date(localMonday as string).getTime();
  const from = usageWeekStart(6, through);
  expect(new Date(from).toISOString()).toBe(expectedUTC);
  expect((through - from) / 3_600_000).toBe(hours);
});

it('totals provider messages within the selected local week', () => {
  const messages = { through: new Date(2027, 0, 4, 12).getTime(), days: [
    { date: '2027-01-01', sent: 3 }, { date: '2027-01-02', sent: 2 },
    { date: '2027-01-03', sent: 4 }, { date: '2027-01-04', sent: 1 }
  ] };
  expect(usageMessageTotals(messages, 1)).toEqual({ date: '2027-01-04', sent: 1 });
  expect(usageMessageTotals(messages, 0)).toEqual({ date: '2027-01-03', sent: 5 });
});

it('keeps provider model names exact and leaves unknown rates unpriced', () => {
  const rows = ['deepseek-chat', 'kimi-k2', 'qwen-plus', 'glm-4'].map(model => ({ model, reasoningEffort: null, assumed: false, tokens: 1 }));
  expect(usageModelGroups(rows).map(group => group.model)).toEqual(rows.map(row => row.model));
  expect(DEFAULT_USAGE_FORMULA.rates).toEqual({});
  for (const model of rows.map(row => row.model)) expect(usageRate(model, DEFAULT_USAGE_FORMULA)).toBeUndefined();
  expect(usageRate('custom-api-model', { ...DEFAULT_USAGE_FORMULA, rates: { 'custom-api-model': 0.8 } })).toBe(0.8);
});
