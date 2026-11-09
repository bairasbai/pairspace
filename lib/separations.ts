import { addDays, dateIn, daysBetween, hourIn, type IsoDate } from './dates.ts';

/** Чистая логика; не проверяет аккаунт, членство или разрешение читать письмо. */
export interface Separation {
  startDate: IsoDate;
  meetDate: IsoDate;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || addDays(value, 0) !== value) {
    throw new RangeError('Нужна существующая дата YYYY-MM-DD');
  }
}

export function validateSeparation(value: Separation): void {
  assertDate(value.startDate);
  assertDate(value.meetDate);
  if (value.startDate > value.meetDate) throw new RangeError('Встреча раньше начала');
}

export function separationLength(value: Separation): number {
  validateSeparation(value);
  return daysBetween(value.startDate, value.meetDate) + 1;
}

export function overlaps(a: Separation, b: Separation): boolean {
  validateSeparation(a);
  validateSeparation(b);
  return a.startDate <= b.meetDate && b.startDate <= a.meetDate;
}

export function letterDate(value: Separation, ordinal: number): IsoDate {
  const total = separationLength(value);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > total) {
    throw new RangeError('Номер письма вне разлуки');
  }
  return addDays(value.startDate, ordinal - 1);
}

export function letterIsOpen(
  value: Separation,
  ordinal: number,
  recipientTimeZone: string,
  now: Date,
  releaseHour = 8,
): boolean {
  if (!Number.isInteger(releaseHour) || releaseHour < 0 || releaseHour > 23) {
    throw new RangeError('Час открытия должен быть от 0 до 23');
  }
  const releaseDate = letterDate(value, ordinal);
  const today = dateIn(recipientTimeZone, now);
  return releaseDate < today || (releaseDate === today && hourIn(recipientTimeZone, now) >= releaseHour);
}
