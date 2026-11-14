export type NotificationCategory = 'care' | 'chat' | 'letter';
export type QuietInterval = Readonly<{ start: string; end: string; timezone: string }>;
export type NotificationFields = Readonly<{ care: boolean; chat: boolean; letter: boolean; quiet: QuietInterval | null }>;
export const defaultNotificationFields: NotificationFields = { care: false, chat: false, letter: false, quiet: null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isNotificationCategory = (v: unknown): v is NotificationCategory => v === 'care' || v === 'chat' || v === 'letter';
const time = (v: unknown): v is string => typeof v === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
export function parseNotificationFields(input: unknown): NotificationFields | null {
  if (!record(input) || Object.keys(input).sort().join(',') !== 'care,chat,letter,quiet'
    || typeof input.care !== 'boolean' || typeof input.chat !== 'boolean' || typeof input.letter !== 'boolean') return null;
  let quiet: QuietInterval | null = null;
  if (input.quiet !== null) {
    const q = input.quiet;
    if (!record(q) || Object.keys(q).sort().join(',') !== 'end,start,timezone' || !time(q.start) || !time(q.end)
      || q.start === q.end || typeof q.timezone !== 'string' || q.timezone.length > 100
      || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(q.timezone)) return null;
    try { new Intl.DateTimeFormat('en', { timeZone: q.timezone }).format(new Date(0)); } catch { return null; }
    quiet = { start: q.start, end: q.end, timezone: q.timezone };
  }
  return { care: input.care, chat: input.chat, letter: input.letter, quiet };
}
export type NotificationDecision = Readonly<{ allowedByPreferences: boolean; reason: 'disabled' | 'quiet_hours' | 'allowed' }>;
/** Read-only own-rule simulation. Neither event authorization nor delivery eligibility. */
export function evaluateNotificationPolicy(fields: NotificationFields, category: NotificationCategory, now: Date): NotificationDecision {
  if (!Number.isFinite(now.getTime())) throw Error('invalid_server_clock');
  if (!fields[category]) return { allowedByPreferences: false, reason: 'disabled' };
  if (fields.quiet) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: fields.quiet.timezone, hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23', numberingSystem: 'latn' }).formatToParts(now);
    const wall = parts.find(p => p.type === 'hour')!.value + ':' + parts.find(p => p.type === 'minute')!.value;
    const { start, end } = fields.quiet;
    if (start < end ? wall >= start && wall < end : wall >= start || wall < end) return { allowedByPreferences: false, reason: 'quiet_hours' };
  }
  return { allowedByPreferences: true, reason: 'allowed' };
}
