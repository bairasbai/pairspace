import { epoch, exact, instant, localDay,
  parseDisputeSchedule, record, uuid } from './validation.ts';
export type { DisputeSchedule } from './validation.ts';
export type DisputeScope = Readonly<{ coupleId: string; userId: string; membershipEpoch: number }>;
export type DisputeMetadata = Readonly<{
  contentState: 'active' | 'removed';
  id: string; coupleId: string; authorId: string; recipientId: string; membershipEpoch: number;
  version: number; createdAt: string; judgeDate: string; timezone: string;
  joinedAt: string | null; declinedAt: string | null; resolvedAt: string | null;
  resolvedBy: string | null; winnerId: string | null; removedAt: string | null;
  decisionState: 'invited' | 'joined' | 'declined' | 'resolved';
}>;
const eventKeys = ['joinedAt', 'declinedAt', 'resolvedAt', 'removedAt'] as const;
const fixedKeys = ['id', 'coupleId', 'authorId', 'recipientId', 'membershipEpoch', 'createdAt', 'judgeDate', 'timezone'] as const;
function validScope(scope: DisputeScope): boolean {
  return record(scope) && uuid(scope.coupleId) && uuid(scope.userId) && epoch(scope.membershipEpoch);
}
export function latestDisputeEvent(value: DisputeMetadata): string {
  return eventKeys.reduce((last, key) => value[key] !== null && value[key]! > last ? value[key]! : last, value.createdAt);
}

/** Structural scope check only, NOT session authentication or current-membership authority. */
export function validDisputeMetadata(value: unknown, scope: DisputeScope): value is DisputeMetadata {
  if (!record(value) || !validScope(scope) || (value.contentState !== 'active' && value.contentState !== 'removed')
    || !exact(value, 'id,coupleId,authorId,recipientId,membershipEpoch,version,createdAt,judgeDate,timezone,joinedAt,declinedAt,resolvedAt,resolvedBy,winnerId,removedAt,decisionState,contentState')
    || !uuid(value.id) || !uuid(value.authorId) || !uuid(value.recipientId) || value.authorId === value.recipientId
    || value.coupleId !== scope.coupleId || value.membershipEpoch !== scope.membershipEpoch
    || ![value.authorId, value.recipientId].includes(scope.userId) || !instant(value.createdAt)) return false;
  const schedule = parseDisputeSchedule({ judgeDate: value.judgeDate, timezone: value.timezone }, value.createdAt);
  if (!schedule || schedule.timezone !== value.timezone) return false;
  for (const key of eventKeys) {
    if (value[key] !== null && (!instant(value[key]) || value[key] < value.createdAt)) return false;
  }
  const joined = value.joinedAt as string | null, declined = value.declinedAt as string | null;
  const resolved = value.resolvedAt as string | null, removed = value.removedAt as string | null;
  if ((value.contentState === 'removed') !== (removed !== null)
    || (joined !== null && localDay(joined, schedule.timezone) >= schedule.judgeDate)
    || (declined !== null && (resolved !== null || (joined !== null && declined < joined)))) return false;
  if (resolved !== null) {
    if (joined === null || resolved < joined || localDay(resolved, schedule.timezone) < schedule.judgeDate
      || !uuid(value.resolvedBy) || ![value.authorId, value.recipientId].includes(value.resolvedBy)
      || (value.winnerId !== null && (!uuid(value.winnerId) || ![value.authorId, value.recipientId].includes(value.winnerId)))) return false;
  } else if (value.resolvedBy !== null || value.winnerId !== null) return false;
  if (removed !== null && [joined, declined, resolved].some(event => event !== null && removed < event)) return false;
  const decision = resolved !== null ? 'resolved' : declined !== null ? 'declined' : joined !== null ? 'joined' : 'invited';
  return value.decisionState === decision && value.version === 1 + eventKeys.filter(key => value[key] !== null).length;
}

/** IDs and participant identities must be supplied by the authorized server, not trusted client claims. */
export function createDisputeMetadata(input: unknown, scope: DisputeScope, trustedNow: string, confirm: boolean): DisputeMetadata | null {
  if (confirm !== true || !validScope(scope) || !instant(trustedNow) || !record(input)
    || !exact(input, 'id,recipientId,judgeDate,timezone') || !uuid(input.id)
    || !uuid(input.recipientId) || input.recipientId === scope.userId) return null;
  const schedule = parseDisputeSchedule({ judgeDate: input.judgeDate, timezone: input.timezone }, trustedNow);
  if (!schedule) return null;
  return { id: input.id, coupleId: scope.coupleId, authorId: scope.userId, recipientId: input.recipientId,
    membershipEpoch: scope.membershipEpoch, version: 1, createdAt: trustedNow, ...schedule,
    contentState: 'active', decisionState: 'invited', joinedAt: null, declinedAt: null,
    resolvedAt: null, resolvedBy: null, winnerId: null, removedAt: null };
}
function canChange(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number, confirm: boolean): value is DisputeMetadata & { contentState: 'active' } {
  return confirm === true && instant(trustedNow) && validDisputeMetadata(value, scope) && value.contentState === 'active'
    && value.version === expectedVersion && trustedNow >= latestDisputeEvent(value);
}
export function joinDisputeMetadata(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number, confirm: boolean): DisputeMetadata | null {
  if (!canChange(value, scope, trustedNow, expectedVersion, confirm) || scope.userId !== value.recipientId
    || value.decisionState !== 'invited' || localDay(trustedNow, value.timezone) >= value.judgeDate) return null;
  return { ...value, joinedAt: trustedNow, decisionState: 'joined', version: value.version + 1 };
}
/** Declining, including voluntary withdrawal after joining, is never an automatic loss. */
export function declineDisputeMetadata(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number, confirm: boolean): DisputeMetadata | null {
  if (!canChange(value, scope, trustedNow, expectedVersion, confirm) || scope.userId !== value.recipientId
    || !['invited', 'joined'].includes(value.decisionState)) return null;
  return { ...value, declinedAt: trustedNow, decisionState: 'declined', version: value.version + 1 };
}
/** Either participant may set one explicit outcome after the judgment day begins locally.
 * null means a draw, not an unset result: resolvedAt/resolvedBy mark a recorded outcome.
 */
export function resolveDisputeMetadata(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number,
  winnerId: unknown, confirm: boolean): DisputeMetadata | null {
  if (!canChange(value, scope, trustedNow, expectedVersion, confirm) || value.decisionState !== 'joined'
    || localDay(trustedNow, value.timezone) < value.judgeDate
    || (winnerId !== null && (!uuid(winnerId) || ![value.authorId, value.recipientId].includes(winnerId)))) return null;
  return { ...value, resolvedAt: trustedNow, resolvedBy: scope.userId, winnerId,
    decisionState: 'resolved', version: value.version + 1 };
}
/** Author-only terminal deletion. Future persistence must erase body atomically. */
export function removeDisputeMetadata(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number, confirm: boolean): DisputeMetadata | null {
  if (!canChange(value, scope, trustedNow, expectedVersion, confirm) || scope.userId !== value.authorId) return null;
  return { id: value.id, coupleId: value.coupleId, authorId: value.authorId, recipientId: value.recipientId,
    membershipEpoch: value.membershipEpoch, createdAt: value.createdAt, judgeDate: value.judgeDate, timezone: value.timezone,
    joinedAt: value.joinedAt, declinedAt: value.declinedAt, resolvedAt: value.resolvedAt,
    resolvedBy: value.resolvedBy, winnerId: value.winnerId, decisionState: value.decisionState,
    contentState: 'removed', removedAt: trustedNow, version: value.version + 1 };
}
export function canReadDisputeMetadata(value: unknown, scope: DisputeScope, trustedNow: string): boolean {
  return instant(trustedNow) && validDisputeMetadata(value, scope) && value.contentState === 'active' && trustedNow >= latestDisputeEvent(value);
}

/** Reject rewritten history, retroactive events, outcome changes and resurrection. */
export function followsDisputeMetadata(old: unknown, next: unknown, scope: DisputeScope): boolean {
  if (!validDisputeMetadata(old, scope) || !validDisputeMetadata(next, scope)
    || !fixedKeys.every(key => old[key] === next[key])) return false;
  if (old.contentState === 'removed') return Object.keys(old).every(key => old[key as keyof DisputeMetadata] === next[key as keyof DisputeMetadata]);
  for (const key of eventKeys) {
    if (old[key] !== null && old[key] !== next[key]) return false;
    if (old[key] === null && next[key] !== null && next[key]! < latestDisputeEvent(old)) return false;
  }
  // A verdict or refusal is final. Only body removal can follow, not inserted consent.
  if ((old.declinedAt !== null || old.resolvedAt !== null)
    && (old.joinedAt !== next.joinedAt || old.declinedAt !== next.declinedAt || old.resolvedAt !== next.resolvedAt)) return false;
  if (old.resolvedAt !== null && (old.resolvedBy !== next.resolvedBy || old.winnerId !== next.winnerId)) return false;
  return true;
}

/** Explicit projection only; caller validates full records or metadata separately.
 * Never preserves an accidental text/extra key from a wider internal object.
 */
export function projectDisputeMetadata(value: DisputeMetadata): DisputeMetadata {
  return { id: value.id, coupleId: value.coupleId, authorId: value.authorId, recipientId: value.recipientId,
    membershipEpoch: value.membershipEpoch, version: value.version, createdAt: value.createdAt,
    judgeDate: value.judgeDate, timezone: value.timezone, contentState: value.contentState,
    decisionState: value.decisionState, joinedAt: value.joinedAt, declinedAt: value.declinedAt,
    resolvedAt: value.resolvedAt, resolvedBy: value.resolvedBy, winnerId: value.winnerId, removedAt: value.removedAt };
}
