import { isDateSchedule, nextOccurrence, zonedLocalDate } from '../../../packages/domain/dates/recurrence.ts';

describe('annual date-only calendar', () => {
  it('requires only meaningful explicit policies', () => {
    for (const policy of [null, undefined, '', 'guess']) expect(isDateSchedule('2000-02-29', 'annual', policy)).toBe(false);
    for (const policy of ['leap_years_only', 'feb28', 'mar1']) expect(isDateSchedule('2000-02-29', 'annual', policy)).toBe(true);
    expect(isDateSchedule('2001-02-29', 'annual', 'feb28')).toBe(false);
    expect(isDateSchedule('2000-02-29', 'weekly', null)).toBe(false);
    expect(isDateSchedule('2000-02-28', 'annual', 'feb28')).toBe(false);
    expect(isDateSchedule('2000-02-29', 'once', null)).toBe(true);
  });
  it('handles all leap policies and Gregorian century exceptions without date instants', () => {
    for (const year of [1900, 2000, 2100]) {
      const leap = year === 2000;
      expect(nextOccurrence('1896-02-29', 'annual', 'leap_years_only', `${year}-02-28`)).toBe(`${leap ? year : year + 4}-02-29`);
      expect(nextOccurrence('1896-02-29', 'annual', 'feb28', `${year}-02-28`)).toBe(`${year}-02-${leap ? '29' : '28'}`);
      expect(nextOccurrence('1896-02-29', 'annual', 'mar1', `${year}-02-28`)).toBe(`${year}-${leap ? '02-29' : '03-01'}`);
    }
  });
  it('is inclusive, anchor bounded, rolls years, and exhausts at year 9999', () => {
    expect(nextOccurrence('2024-12-31', 'annual', null, '2026-12-31')).toBe('2026-12-31');
    expect(nextOccurrence('2024-01-01', 'annual', null, '2026-12-31')).toBe('2027-01-01');
    expect(nextOccurrence('2032-02-29', 'annual', 'feb28', '2026-01-01')).toBe('2032-02-29');
    expect(nextOccurrence('2024-02-29', 'annual', 'feb28', '2025-03-01')).toBe('2026-02-28');
    expect(nextOccurrence('9996-02-29', 'annual', 'leap_years_only', '9997-01-01')).toBeNull();
    expect(nextOccurrence('9999-01-01', 'annual', null, '9999-12-31')).toBeNull();
    expect(nextOccurrence('0001-01-01', 'once', null, '0001-01-01')).toBe('0001-01-01');
    expect(nextOccurrence('0001-01-01', 'once', null, '0001-01-02')).toBeNull();
    expect(nextOccurrence('2000-02-29', 'annual', null, '2000-01-01')).toBeNull();
    expect(nextOccurrence('2000-01-01', 'annual', null, '10000-01-01')).toBeNull();
  });
  it('takes trusted zone date from instant; DST never shifts anniversary labels', () => {
    const now = new Date('2026-11-10T00:30:00.000Z');
    expect(zonedLocalDate(now, 'Asia/Tokyo')).toBe('2026-11-10');
    expect(zonedLocalDate(now, 'America/Los_Angeles')).toBe('2026-11-09');
    for (const instant of ['2026-03-08T09:59:00Z', '2026-03-08T10:01:00Z', '2026-11-01T08:59:00Z', '2026-11-01T09:01:00Z']) {
      const day = zonedLocalDate(new Date(instant), 'America/Los_Angeles')!;
      expect(nextOccurrence(`2024-${day.slice(5)}`, 'annual', null, day)).toBe(day);
    }
    expect(zonedLocalDate(new Date('0001-01-01T12:00:00Z'), 'UTC')).toBe('0001-01-01');
    expect(zonedLocalDate(new Date('0000-12-31T12:00:00Z'), 'UTC')).toBeNull();
    expect(zonedLocalDate(new Date('+010000-01-01T12:00:00Z'), 'UTC')).toBeNull();
    expect(zonedLocalDate(new Date('invalid'), 'UTC')).toBeNull();
    expect(zonedLocalDate(now, 'Invalid/Zone')).toBeNull();
  });
});
