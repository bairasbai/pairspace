export type HardQuestion = Readonly<{
  id: string; coupleId: string; authorId: string; recipientId: string;
  membershipEpoch: number; sequence: number; version: number; createdAt: string;
  contentState: 'active' | 'removed'; decisionState: 'sealed' | 'opened' | 'declined' | 'withdrawn';
  openedAt?: string;
}>;
export type HardScope = Readonly<{ coupleId: string; membershipEpoch: number; userId: string }>;
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function instant(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export function validQuestion(v: unknown, scope: HardScope): v is HardQuestion {
  if (!record(v) || !['active', 'removed'].includes(String(v.contentState))
    || !['sealed', 'opened', 'declined', 'withdrawn'].includes(String(v.decisionState))) return false;
  const active = v.contentState === 'active', opened = v.decisionState === 'opened';
  if (!exact(v, 'id,coupleId,authorId,recipientId,membershipEpoch,sequence,version,createdAt,contentState,decisionState' + (opened ? ',openedAt' : ''))
    || !uuid(v.id) || !uuid(v.authorId) || !uuid(v.recipientId) || v.authorId === v.recipientId
    || ![v.authorId, v.recipientId].includes(scope.userId) || v.coupleId !== scope.coupleId || v.membershipEpoch !== scope.membershipEpoch
    || !instant(v.createdAt) || !Number.isInteger(v.sequence) || Number(v.sequence) < 1 || Number(v.sequence) > 100) return false;
  if ((!active && v.decisionState === 'sealed') || (active && v.decisionState === 'withdrawn')) return false;
  const version = v.decisionState === 'sealed' ? 1 : v.decisionState === 'withdrawn' ? 2 : 2 + (active ? 0 : 1);
  return v.version === version && (!opened || (instant(v.openedAt) && v.openedAt >= v.createdAt));
}
export function followsQuestion(old: HardQuestion, next: HardQuestion): boolean {
  if (!['id', 'coupleId', 'authorId', 'recipientId', 'membershipEpoch', 'sequence', 'createdAt']
    .every(k => old[k as keyof HardQuestion] === next[k as keyof HardQuestion]) || next.version < old.version) return false;
  if (old.contentState === 'removed' && next.contentState !== 'removed') return false;
  if (old.decisionState !== 'sealed' && old.decisionState !== next.decisionState) return false;
  if (old.openedAt && old.openedAt !== next.openedAt) return false;
  const removal = old.contentState !== next.contentState && next.decisionState !== 'withdrawn' ? 1 : 0;
  const decision = old.decisionState !== next.decisionState ? 1 : 0;
  const steps = removal + decision;
  return next.version === old.version + steps && (steps > 0 || Object.keys(old).every(k => old[k as keyof HardQuestion] === next[k as keyof HardQuestion]));
}
export const orderQuestions = (a: HardQuestion, b: HardQuestion) => Number(b.decisionState === 'sealed') - Number(a.decisionState === 'sealed') || b.sequence - a.sequence;
export const canReadQuestion = (q: HardQuestion, actor: string) => q.contentState === 'active' && (q.authorId === actor || (q.recipientId === actor && q.decisionState === 'opened'));
