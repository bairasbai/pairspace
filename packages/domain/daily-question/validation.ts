import { exact, instant, record } from '../hard/metadata.ts';
export { exact, instant, record };
export const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const count = (value: unknown): value is number => typeof value === 'number'
  && Number.isInteger(value) && value >= 1 && value <= 2147483646;
export function localDay(trustedNow: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' }).formatToParts(new Date(trustedNow));
  if (parts.find(part => part.type === 'era')!.value !== 'AD') return '';
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value.padStart(key === 'year' ? 4 : 2, '0')).join('-');
}
export function normalizeDailyAnswerText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8000 || /\r(?!\n)/.test(value)
    || /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return null;
  const normalized = value.normalize('NFC').replace(/\r\n/g, '\n');
  if (/\p{Cc}/u.test(normalized.replace(/\n/g, ''))) return null;
  const text = normalized.trim();
  return text && [...text].length <= 2000 ? text : null;
}

export const normalizeDailyAnswer = normalizeDailyAnswerText;
