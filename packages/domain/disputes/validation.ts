import { exact, instant, record } from '../hard/metadata.ts';
import { parseMorningPreference } from '../letters/morning.ts';
export { exact, instant, record };
export const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const epoch = (value: unknown): value is number => Number.isInteger(value)
  && Number(value) >= 1 && Number(value) <= 2147483646;
export type DisputeSchedule = Readonly<{ judgeDate: string; timezone: string }>;

/** Calendar validation only. This UTC construction never determines when a dispute is due. */
function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function localDay(trustedNow: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(trustedNow));
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-');
}
/** Future local calendar date, not an invented UTC midnight, fixed duration or notification. */
export function parseDisputeSchedule(input: unknown, trustedNow: string): DisputeSchedule | null {
  if (!record(input) || !exact(input, 'judgeDate,timezone') || !instant(trustedNow) || !calendarDate(input.judgeDate)) return null;
  const preference = parseMorningPreference(input.timezone, '00:00');
  if (!preference || input.judgeDate <= localDay(trustedNow, preference.timezone)) return null;
  return { judgeDate: input.judgeDate, timezone: preference.timezone };
}
function normalizedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length > maximum * 4 || /\r(?!\n)/.test(value)
    || /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return undefined;
  const normalized = value.normalize('NFC').replace(/\r\n/g, '\n');
  if (/\p{Cc}/u.test(normalized.replace(/\n/g, ''))) return undefined;
  const text = normalized.trim();
  return [...text].length <= maximum ? text : undefined;
}
export function normalizeDisputeClaim(value: unknown): string | null {
  return normalizedText(value, 2000) || null;
}
/** undefined means invalid; null means explicitly absent or a blank optional condition. */
export function normalizeDisputeCondition(value: unknown): string | null | undefined {
  if (value === null) return null;
  const text = normalizedText(value, 500);
  return text === '' ? null : text;
}
