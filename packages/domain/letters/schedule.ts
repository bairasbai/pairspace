/** Explicit wall time + offset + IANA zone, never guess a DST fold or gap. */
export type LetterSchedule = Readonly<{ releaseAt: string; releaseTimezone: string }>;
export const MIN_LETTER_DELAY_MS = 60_000;
export const MAX_LETTER_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
export function parseLetterSchedule(releaseAt: unknown, releaseTimezone: unknown): LetterSchedule | null {
  if (typeof releaseAt !== 'string' || typeof releaseTimezone !== 'string'
    || releaseTimezone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(releaseTimezone)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/.exec(releaseAt);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , offset] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  if (parts[0] < 2000 || parts[0] > 9999 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59
    || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) return null;
  const instant = new Date(releaseAt);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: releaseTimezone,
      calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const wall = formatter.formatToParts(instant);
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].some((key, index) =>
      Number(wall.find(part => part.type === key)?.value) !== parts[index])) return null;
    return { releaseAt: instant.toISOString(), releaseTimezone };
  } catch { return null; }
}
export function scheduleWithinWindow(schedule: LetterSchedule, now: Date): boolean {
  const delay = Date.parse(schedule.releaseAt) - now.getTime();
  return delay >= MIN_LETTER_DELAY_MS && delay <= MAX_LETTER_DELAY_MS;
}
