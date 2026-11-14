import { isLocalDate, validatedTimezone } from '../dates/calendar.ts';
/** Exactly one midnight instant; reject civil gaps/folds rather than silently choosing. */
function midnight(date: string, timezone: string): string | null {
  const nominal = Date.parse(`${date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, calendar: 'iso8601',
    numberingSystem: 'latn', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const matches: number[] = [];
  // IANA offsets in supported 2000–2101 range are whole minutes, at most 14h.
  for (let minute = -14 * 60; minute <= 14 * 60; minute++) {
    const instant = nominal + minute * 60000;
    const p = Object.fromEntries(formatter.formatToParts(instant).map(x => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === date && p.hour === '00' && p.minute === '00' && p.second === '00') matches.push(instant);
  }
  return matches.length === 1 ? new Date(matches[0]).toISOString() : null;
}
export function partingRange(startDate: unknown, endDate: unknown, timezone: unknown): { startsAt: string; endsAt: string } | null {
  if (!isLocalDate(startDate) || !isLocalDate(endDate) || startDate < '2000-01-01' || endDate > '2100-12-31'
    || startDate > endDate || !validatedTimezone(timezone)) return null;
  const following = new Date(Date.parse(`${endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const startsAt = midnight(startDate, timezone as string), endsAt = midnight(following, timezone as string);
  return startsAt && endsAt && startsAt < endsAt ? { startsAt, endsAt } : null;
}
