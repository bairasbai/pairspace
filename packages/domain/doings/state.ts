export type DoingKind = 'book' | 'series' | 'course' | 'other';
type Identity = Readonly<{ id: string; coupleId: string; authorId: string; recipientId: string;
  membershipEpoch: number; sequence: number; version: number; createdAt: string }>;
export type SharedDoing = Readonly<Identity & (
  { contentState: 'active'; title: string; kind: DoingKind; parts: number; authorAt: number } & (
    { decisionState: 'joined'; recipientAt: number } | { decisionState: 'invited' | 'declined' })
  | { contentState: 'removed'; decisionState: 'withdrawn' | 'joined' | 'declined' })>;
export type DoingScope = Readonly<{ coupleId: string; userId: string; membershipEpoch: number }>;
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const kind = (v: unknown): v is DoingKind => typeof v === 'string' && ['book', 'series', 'course', 'other'].includes(v);
export function instant(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export function normalizeDoingTitle(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 800 || /[\uD800-\uDFFF]/u.test(v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return null;
  const normalized = v.normalize('NFC').replace(/\r\n?/g, '\n');
  if (/\p{Cc}/u.test(normalized)) return null;
  const title = normalized.trim();
  return title && [...title].length <= 200 ? title : null;
}
const positive = (v: number) => Number(v > 0);
const within = (v: number, min: number, max: number) => v >= min && v <= max;
export function validDoing(v: unknown, scope: DoingScope): v is SharedDoing {
  if (!record(v) || !['active', 'removed'].includes(String(v.contentState))
    || !['invited', 'joined', 'declined', 'withdrawn'].includes(String(v.decisionState))) return false;
  const active = v.contentState === 'active', joined = v.decisionState === 'joined';
  if (!exact(v, 'id,coupleId,authorId,recipientId,membershipEpoch,sequence,version,createdAt,contentState,decisionState'
    + (active ? ',title,kind,parts,authorAt' + (joined ? ',recipientAt' : '') : ''))
    || !uuid(v.id) || !uuid(v.coupleId) || !uuid(v.authorId) || !uuid(v.recipientId) || v.authorId === v.recipientId
    || ![v.authorId, v.recipientId].includes(scope.userId) || v.coupleId !== scope.coupleId || v.membershipEpoch !== scope.membershipEpoch
    || !integer(v.membershipEpoch, 1, 2147483646) || !instant(v.createdAt) || !integer(v.sequence, 1, 100) || !integer(v.version, 1, 2004)) return false;
  if (!active) return v.decisionState === 'withdrawn' ? within(v.version, 2, 1002)
    : v.decisionState === 'joined' ? within(v.version, 3, 2003) : v.decisionState === 'declined' && within(v.version, 3, 2004);
  if (typeof v.title !== 'string' || normalizeDoingTitle(v.title) !== v.title || !kind(v.kind) || !integer(v.parts, 1, 1000)
    || !integer(v.authorAt, 0, v.parts)) return false;
  if (v.decisionState === 'invited') return within(v.version, 1 + positive(v.authorAt), 1 + v.authorAt);
  if (joined) return integer(v.recipientAt, 0, v.parts)
    && within(v.version, 2 + positive(v.authorAt) + positive(v.recipientAt), 2 + v.authorAt + v.recipientAt);
  return v.decisionState === 'declined' && within(v.version, 2 + positive(v.authorAt), 3 + v.authorAt + v.parts);
}
const signature = (d: SharedDoing) => JSON.stringify([d.id, d.coupleId, d.authorId, d.recipientId, d.membershipEpoch,
  d.sequence, d.version, d.createdAt, d.contentState, d.decisionState, ...(d.contentState === 'active'
    ? [d.title, d.kind, d.parts, d.authorAt, ...(d.decisionState === 'joined' ? [d.recipientAt] : [])] : [])]);
export function followsDoing(old: SharedDoing, next: SharedDoing): boolean {
  if (!['id', 'coupleId', 'authorId', 'recipientId', 'membershipEpoch', 'sequence', 'createdAt']
    .every(k => old[k as keyof Identity] === next[k as keyof Identity]) || next.version < old.version) return false;
  if (next.version === old.version) return signature(old) === signature(next);
  if (old.contentState === 'removed') return false;
  const delta = next.version - old.version, a = old.parts - old.authorAt;
  const r = old.decisionState === 'joined' ? old.parts - old.recipientAt : old.parts;
  if (next.contentState === 'removed') {
    if (old.decisionState === 'invited') return next.decisionState === 'withdrawn' ? within(delta, 1, 1 + a)
      : next.decisionState === 'joined' ? within(delta, 2, 2 + a + r) : within(delta, 2, 3 + a + r);
    if (old.decisionState === 'joined') return next.decisionState === 'joined' ? within(delta, 1, 1 + a + r)
      : next.decisionState === 'declined' && within(delta, 2, 2 + a + r);
    return next.decisionState === 'declined' && delta === 1;
  }
  if (old.title !== next.title || old.kind !== next.kind || old.parts !== next.parts || next.authorAt < old.authorAt) return false;
  const da = next.authorAt - old.authorAt;
  if (old.decisionState === 'invited') {
    if (next.decisionState === 'invited') return within(delta, positive(da), da);
    if (next.decisionState === 'joined') return within(delta, 1 + positive(da) + positive(next.recipientAt), 1 + da + next.recipientAt);
    return within(delta, 1 + positive(da), 2 + da + old.parts);
  }
  if (old.decisionState === 'joined') {
    if (next.decisionState === 'declined') return within(delta, 1 + positive(da), 1 + da + r);
    if (next.decisionState !== 'joined' || next.recipientAt < old.recipientAt) return false;
    const dr = next.recipientAt - old.recipientAt;
    return within(delta, positive(da) + positive(dr), da + dr);
  }
  return false;
}
export const completeDoing = (d: SharedDoing) => d.contentState === 'active' && d.decisionState === 'joined' && d.authorAt === d.parts && d.recipientAt === d.parts;
export function canAdvanceDoing(d: SharedDoing, actor: string): boolean {
  return d.contentState === 'active' && d.decisionState !== 'declined'
    && (actor === d.authorId ? d.authorAt < d.parts : actor === d.recipientId && d.decisionState === 'joined' && d.recipientAt < d.parts);
}
const bucket = (d: SharedDoing) => d.contentState === 'removed' ? 2 : d.decisionState === 'declined' || completeDoing(d) ? 1 : 0;
export const orderDoings = (a: SharedDoing, b: SharedDoing) => bucket(a) - bucket(b) || b.sequence - a.sequence;
