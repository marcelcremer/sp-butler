// Date helpers. Everything works on the user's *local* calendar day, formatted
// as YYYY-MM-DD, which is what Super Productivity stores in `task.dueDay`.

import type { Task } from '../types/plugin-api.ts';

const WEEKDAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
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
  [-1]: ' (gestern / yesterday)',
  0: ' (heute / today)',
  1: ' (morgen / tomorrow)',
  2: ' (übermorgen)',
};

/**
 * A compact calendar the model can look up instead of doing weekday arithmetic
 * itself, which LLMs are notoriously bad at ("nächsten Freitag" etc.).
 */
export const buildCalendarContext = (now = new Date(), daysAhead = 14): string => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = (d: Date): string => WEEKDAYS_DE[d.getDay()] ?? '';
  const lines: string[] = [];
  for (let i = -1; i <= daysAhead; i++) {
    const day = addDays(today, i);
    lines.push(
      `${toDayStr(day)} ${weekday(day)} / ${WEEKDAYS_EN[day.getDay()] ?? ''}${RELATIVE_LABELS[i] ?? ''}`,
    );
  }
  const weekStart = startOfWeek(today);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [
    `Heute / today: ${toDayStr(today)} (${weekday(today)}), Zeitzone: ${tz}`,
    `Diese Woche / this week: ${toDayStr(weekStart)} bis ${toDayStr(addDays(weekStart, 6))}`,
    `Nächste Woche / next week: ${toDayStr(addDays(weekStart, 7))} bis ${toDayStr(addDays(weekStart, 13))}`,
    'Kalender:',
    ...lines,
  ].join('\n');
};
