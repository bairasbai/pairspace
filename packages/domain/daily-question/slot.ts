import { canonicalDailyDate, dailyPrompt } from './catalog.ts';
import { exact, instant, localDay, record, uuid } from './validation.ts';
export type DailyScope = Readonly<{ coupleId: string; membershipEpoch: number; userId: string }>;
export type DailySlot = Readonly<{
  id: string; coupleId: string; membershipEpoch: number; participantIds: readonly [string, string];
  day: string; timezone: string; createdAt: string;
  catalogVersion: string; promptId: string; promptRU: string; promptEN: string;
}>;
const epoch = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2147483646;
function zone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; } catch { return null; }
}
/** Current membership is asserted by a trusted caller, not authenticated here. */
export function validDailySlot(value: unknown, scope: DailyScope): value is DailySlot {
  if (!record(value) || !record(scope) || !uuid(scope.coupleId) || !uuid(scope.userId) || !epoch(scope.membershipEpoch)
    || !exact(value, 'id,coupleId,membershipEpoch,participantIds,day,timezone,createdAt,catalogVersion,promptId,promptRU,promptEN')
    || !uuid(value.id) || value.coupleId !== scope.coupleId || value.membershipEpoch !== scope.membershipEpoch
    || !Array.isArray(value.participantIds) || value.participantIds.length !== 2 || !uuid(value.participantIds[0]) || !uuid(value.participantIds[1])
    || value.participantIds[0] >= value.participantIds[1] || !value.participantIds.includes(scope.userId)
    || !canonicalDailyDate(value.day) || !instant(value.createdAt) || value.createdAt.startsWith('0000-') || typeof value.timezone !== 'string' || zone(value.timezone) !== value.timezone
    || localDay(value.createdAt, value.timezone as string) !== value.day) return false;
  const prompt = dailyPrompt(value.day, value.catalogVersion);
  return prompt !== null && value.promptId === prompt.promptId && value.promptRU === prompt.promptRU && value.promptEN === prompt.promptEN;
}
/** IDs, pair zone and participant identities come from the authorized server.
 * The unique (couple, epoch, day) slot is persisted once; callers must not recreate it.
 */
export function createDailySlot(input: unknown, scope: DailyScope, trustedNow: string): DailySlot | null {
  if (!record(scope) || !record(input) || !exact(input, 'id,participantIds,timezone') || !instant(trustedNow) || trustedNow.startsWith('0000-')) return null;
  const timezone = zone(input.timezone);
  if (timezone === null) return null;
  const day = localDay(trustedNow, timezone), prompt = dailyPrompt(day);
  if (!prompt) return null;
  const value = { ...input, ...prompt, coupleId: scope.coupleId, membershipEpoch: scope.membershipEpoch, day, timezone, createdAt: trustedNow };
  return validDailySlot(value, scope) ? value : null;
}
