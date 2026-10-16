import type { UsageMessageDay, UsageOverview } from './types.js';

export function usageDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Calendar days preserve daylight-saving transitions.
export function usageWeekStart(weekday: number, through: number): number {
  const date = new Date(through);
  date.setDate(date.getDate() - (date.getDay() - weekday + 7) % 7);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function usageMessageTotals(messages: UsageOverview['messages'], weekday: number): UsageMessageDay {
  const from = usageDateKey(new Date(usageWeekStart(weekday, messages.through)));
  const through = usageDateKey(new Date(messages.through));
  const sent = messages.days.reduce((total, day) => day.date >= from && day.date <= through ? total + day.sent : total, 0);
  return { date: from, sent };
}
