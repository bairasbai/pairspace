import { expect, it } from 'vitest';
import { parseLetterSchedule, scheduleWithinWindow, MAX_LETTER_DELAY_MS } from '../../../packages/domain/letters/schedule.ts';
it('requires explicit real calendar dates and timezone offset, rejects DST gaps, resolves folds only explicitly', () => {
  expect(parseLetterSchedule('2026-11-01T01:30:00-04:00', 'America/New_York')?.releaseAt).toBe('2026-11-01T05:30:00.000Z');
  expect(parseLetterSchedule('2026-11-01T01:30:00-05:00', 'America/New_York')?.releaseAt).toBe('2026-11-01T06:30:00.000Z');
  expect(parseLetterSchedule('2028-02-29T12:00:00.123Z', 'UTC')?.releaseAt).toBe('2028-02-29T12:00:00.123Z');
  for (const value of [null, 1, '', '2026-11-10T01:00', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
    '1999-01-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+00:60', '2026-13-01T00:00:00Z']) {
    expect(parseLetterSchedule(value, 'UTC')).toBeNull();
  }
  for (const zone of [null, 1, '', 'x'.repeat(101), 'GMT+3', 'Missing/Zone', ' UTC']) expect(parseLetterSchedule('2026-01-01T00:00:00Z', zone)).toBeNull();
  for (const offset of ['-04:00', '-05:00']) expect(parseLetterSchedule('2026-03-08T02:30:00' + offset, 'America/New_York')).toBeNull();
  expect(parseLetterSchedule('2026-11-01T01:30:00-06:00', 'America/New_York')).toBeNull();
  expect(parseLetterSchedule('2026-11-10T06:00:00+05:45', 'Asia/Kathmandu')?.releaseAt).toBe('2026-11-10T00:15:00.000Z');
});
it('bounds delay by elapsed time inclusive, never by local calendar or client time', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  for (const [delay, expected] of [[59_999, false], [60_000, true], [MAX_LETTER_DELAY_MS, true], [MAX_LETTER_DELAY_MS + 1, false]] as const) {
    expect(scheduleWithinWindow({ releaseAt: new Date(+now + delay).toISOString(), releaseTimezone: 'UTC' }, now)).toBe(expected);
  }
});
