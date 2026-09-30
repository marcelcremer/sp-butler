// Date helpers. Everything works on the user's *local* calendar day, formatted
// as YYYY-MM-DD, which is what Super Productivity stores in `task.dueDay`.

import type { Task } from '../types/plugin-api.ts';

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number): string => String(n).padStart(2, '0');

export const toDayStr = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Parses YYYY-MM-DD as local midnight (Date.parse would use UTC). Invalid -> NaN date. */
export const parseDayStr = (str: string): Date => {
  const [y = NaN, m = NaN, d = NaN] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
    ? date
    : new Date(NaN);
};

export const isDayStr = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(parseDayStr(value).getTime());

export const addDays = (date: Date, days: number): Date => {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
};

/** Monday-based week start. */
export const startOfWeek = (date: Date): Date => addDays(date, -((date.getDay() + 6) % 7));

/** The effective due day of a task: `dueDay`, or the day of `dueWithTime`. */
export const taskDueDay = (task: Pick<Task, 'dueDay' | 'dueWithTime'>): string | null => {
  if (task.dueDay) return task.dueDay;
  if (task.dueWithTime) return toDayStr(new Date(task.dueWithTime));
  return null;
};

const RELATIVE_LABELS: Record<number, string> = {
  [-1]: ' (yesterday)',
  0: ' (today)',
  1: ' (tomorrow)',
  2: ' (day after tomorrow)',
};

/**
 * A compact calendar the model can look up instead of doing weekday arithmetic
 * itself, which LLMs are notoriously bad at ("next Friday" etc.).
 */
export const buildCalendarContext = (now = new Date(), daysAhead = 14): string => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = (d: Date): string => WEEKDAYS_EN[d.getDay()] ?? '';
  const lines: string[] = [];
  for (let i = -1; i <= daysAhead; i++) {
    const day = addDays(today, i);
    lines.push(
      `${toDayStr(day)} ${weekday(day)}${RELATIVE_LABELS[i] ?? ''}`,
    );
  }
  const weekStart = startOfWeek(today);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [
    `Today: ${toDayStr(today)} (${weekday(today)}), time zone: ${tz}`,
    `This week: ${toDayStr(weekStart)} to ${toDayStr(addDays(weekStart, 6))}`,
    `Next week: ${toDayStr(addDays(weekStart, 7))} to ${toDayStr(addDays(weekStart, 13))}`,
    'Calendar:',
    ...lines,
  ].join('\n');
};
