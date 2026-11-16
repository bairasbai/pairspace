import { exact, normalizeDisputeClaim, normalizeDisputeCondition, parseDisputeSchedule, record } from './validation.ts';
import { canReadDisputeMetadata, createDisputeMetadata, declineDisputeMetadata, followsDisputeMetadata,
  joinDisputeMetadata, projectDisputeMetadata, removeDisputeMetadata, resolveDisputeMetadata, validDisputeMetadata,
  type DisputeMetadata, type DisputeScope } from './metadata.ts';
export { normalizeDisputeClaim, normalizeDisputeCondition, parseDisputeSchedule };
export type { DisputeSchedule } from './validation.ts';
export type { DisputeScope } from './metadata.ts';
/** Active terms are shared with the two scoped participants; removal omits both text keys. */
export type Dispute = DisputeMetadata & (
  Readonly<{ contentState: 'active'; claim: string; condition: string | null }>
  | Readonly<{ contentState: 'removed' }>
);
const metadataKeys = 'id,coupleId,authorId,recipientId,membershipEpoch,version,createdAt,judgeDate,timezone,joinedAt,declinedAt,resolvedAt,resolvedBy,winnerId,removedAt,decisionState,contentState';

/** Full-content validation remains strict; metadata validation never fabricates content. */
export function validDispute(value: unknown, scope: DisputeScope): value is Dispute {
  if (!record(value) || !exact(value, metadataKeys + (value.contentState === 'active' ? ',claim,condition' : ''))) return false;
  if (value.contentState === 'active' && (normalizeDisputeClaim(value.claim) !== value.claim
    || typeof value.claim !== 'string' || normalizeDisputeCondition(value.condition) !== value.condition
    || (value.condition !== null && typeof value.condition !== 'string'))) return false;
  // Projection is not authority: every projected field is checked by the shared validator.
  return validDisputeMetadata(projectDisputeMetadata(value as DisputeMetadata), scope);
}
export function createDispute(input: unknown, scope: DisputeScope, trustedNow: string, confirm: boolean): Dispute | null {
  if (!record(input) || !exact(input, 'id,recipientId,claim,condition,judgeDate,timezone')) return null;
  const metadata = createDisputeMetadata({ id: input.id, recipientId: input.recipientId,
    judgeDate: input.judgeDate, timezone: input.timezone }, scope, trustedNow, confirm);
  const claim = normalizeDisputeClaim(input.claim), condition = normalizeDisputeCondition(input.condition);
  return metadata && claim !== null && condition !== undefined ? { ...metadata, contentState: 'active', claim, condition } : null;
}
function change(value: unknown, scope: DisputeScope, operation: (metadata: DisputeMetadata) => DisputeMetadata | null): Dispute | null {
  if (!validDispute(value, scope) || value.contentState !== 'active') return null;
  const next = operation(projectDisputeMetadata(value));
  if (!next) return null;
  if (next.contentState === 'removed') return { ...next, contentState: 'removed' };
  // Every non-removal operation preserves the active record's exact terms.
  return { ...next, contentState: 'active', claim: value.claim, condition: value.condition };
}
export function joinDispute(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number, confirm: boolean): Dispute | null {
  return change(value, scope, metadata => joinDisputeMetadata(metadata, scope, trustedNow, expectedVersion, confirm));
}
export function declineDispute(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number, confirm: boolean): Dispute | null {
  return change(value, scope, metadata => declineDisputeMetadata(metadata, scope, trustedNow, expectedVersion, confirm));
}
export function resolveDispute(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number,
  winnerId: unknown, confirm: boolean): Dispute | null {
  return change(value, scope, metadata => resolveDisputeMetadata(metadata, scope, trustedNow, expectedVersion, winnerId, confirm));
}
export function removeDispute(value: unknown, scope: DisputeScope, trustedNow: string, expectedVersion: number, confirm: boolean): Dispute | null {
  return change(value, scope, metadata => removeDisputeMetadata(metadata, scope, trustedNow, expectedVersion, confirm));
}
export function canReadDisputeText(value: unknown, scope: DisputeScope, trustedNow: string): boolean {
  return validDispute(value, scope) && canReadDisputeMetadata(projectDisputeMetadata(value), scope, trustedNow);
}
export function followsDispute(old: unknown, next: unknown, scope: DisputeScope): boolean {
  if (!validDispute(old, scope) || !validDispute(next, scope)) return false;
  if (old.contentState === 'active' && next.contentState === 'active' && (old.claim !== next.claim || old.condition !== next.condition)) return false;
  return followsDisputeMetadata(projectDisputeMetadata(old), projectDisputeMetadata(next), scope);
}
