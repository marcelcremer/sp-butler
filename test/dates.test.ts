import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  buildCalendarContext,
  isDayStr,
  parseDayStr,
  startOfWeek,
  taskDueDay,
  toDayStr,
} from '../src/plugin/dates.ts';
import { NOW } from './helpers.ts';

describe('dates', () => {
  it('formats and parses local days', () => {
    assert.equal(toDayStr(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(toDayStr(parseDayStr('2026-02-28')), '2026-02-28');
  });

  it('validates day strings', () => {
    assert.ok(isDayStr('2026-10-02'));
    assert.ok(!isDayStr('2026-02-30'));
    assert.ok(!isDayStr('02.10.2026'));
    assert.ok(!isDayStr(null));
  });

  it('adds days across month boundaries', () => {
    assert.equal(toDayStr(addDays(NOW, 2)), '2026-10-02');
  });

  it('starts weeks on Monday', () => {
    assert.equal(toDayStr(startOfWeek(NOW)), '2026-09-28');
    assert.equal(toDayStr(startOfWeek(new Date(2026, 9, 4))), '2026-09-28'); // Sunday
  });

  it('derives the due day from dueWithTime', () => {
    assert.equal(taskDueDay({ dueDay: null, dueWithTime: new Date(2026, 9, 1, 9).getTime() }), '2026-10-01');
    assert.equal(taskDueDay({ dueDay: '2026-10-03', dueWithTime: null }), '2026-10-03');
    assert.equal(taskDueDay({}), null);
  });

  it('builds a calendar with weekday names and relative labels', () => {
    const ctx = buildCalendarContext(NOW);
    assert.match(ctx, /Today: 2026-09-30 \(Wednesday\)/);
    assert.match(ctx, /2026-10-01 Thursday \(tomorrow\)/);
    assert.match(ctx, /2026-10-02 Friday \(day after tomorrow\)/);
    assert.match(ctx, /This week: 2026-09-28 to 2026-10-04/);
  });
});
