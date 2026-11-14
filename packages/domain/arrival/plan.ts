import { normalizeTaskTitle } from '../tasks/title.ts';
import { parseMorningPreference, resolveMorningChoice } from '../letters/morning.ts';
export type ArrivalFields = Readonly<{ label: string; localDate: string; localTime: string;
  timezone: string; offset: string; arrivesAt: string }>;
/** A manually entered plan, not airline status or a promise of meeting. No device-clock defaults. */
export function parseArrivalFields(label: unknown, localDate: unknown, localTime: unknown,
  timezone: unknown, offset: unknown): ArrivalFields | null {
  const title = typeof label === 'string' && label.trim() === '' ? { ok: true as const, text: '' } : normalizeTaskTitle(label), preference = parseMorningPreference(timezone, localTime);
  const choice = resolveMorningChoice(localDate, localTime, timezone, offset);
  if (!title.ok || !preference || !choice) return null;
  return { label: title.text, localDate: localDate as string, localTime: preference.localTime,
    timezone: preference.timezone, offset: choice.offset, arrivesAt: choice.releaseAt };
}
