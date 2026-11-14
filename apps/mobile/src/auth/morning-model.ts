export type MorningScope = { coupleId: string; userId: string; membershipEpoch: number };
export type Preference = { userId: string; timezone: string; localTime: string; version: number };
export type MorningSlot = {
  id: string; coupleId: string; membershipEpoch: number; senderId: string; recipientId: string;
  localDate: string; localTime: string; timezone: string; offset: string; releaseAt: string;
  preferenceVersion: number; createdAt: string; state: 'sealed' | 'available' | 'missed'; prepared?: boolean; openedAt?: string | null;
};
export type MorningCursor = { id: string; releaseAt: string };
export type MorningPage = {
  readId: string; serverNow: string; preferences: Preference[]; slots: MorningSlot[];
  hasOlder: boolean; hasNewer: boolean; olderCursor: MorningCursor | null;
  newerCursor: MorningCursor | null; lastAvailableId: string | null;
};
type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const slotKeys = ['id', 'coupleId', 'membershipEpoch', 'senderId', 'recipientId', 'localDate',
  'localTime', 'timezone', 'offset', 'releaseAt', 'preferenceVersion', 'createdAt', 'state'];
function object(v: unknown): v is RecordValue { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v: RecordValue, keys: string[]): boolean {
  return Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function uuid(v: unknown): v is string { return typeof v === 'string' && UUID.test(v); }
function positive(v: unknown): v is number { return Number.isSafeInteger(v) && Number(v) > 0; }
function iso(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
function zone(v: unknown): v is string {
  if (typeof v !== 'string' || !v || v.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; }
}
function scopeValid(s: MorningScope): boolean { return uuid(s.userId) && uuid(s.coupleId) && positive(s.membershipEpoch); }
export function parseMorningPreference(v: unknown, scope?: MorningScope): Preference | null {
  if (!object(v) || !exact(v, ['userId', 'timezone', 'localTime', 'version']) || !uuid(v.userId)
    || !zone(v.timezone) || typeof v.localTime !== 'string' || !TIME.test(v.localTime)
    || !positive(v.version) || (scope && !scopeValid(scope))) return null;
  return v as Preference;
}
function snapshot(v: RecordValue): boolean {
  if (typeof v.localDate !== 'string' || !/^(?:20\d\d|2100)-\d\d-\d\d$/.test(v.localDate)
    || typeof v.localTime !== 'string' || !TIME.test(v.localTime) || !zone(v.timezone)
    || typeof v.offset !== 'string' || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(v.offset)
    || !iso(v.releaseAt)) return false;
  const local = `${v.localDate}T${v.localTime}:00.000Z`;
  if (!iso(local)) return false;
  const minutes = Number(v.offset.slice(1, 3)) * 60 + Number(v.offset.slice(4));
  if (minutes > 840 || v.offset === '-00:00') return false;
  return Date.parse(local) - (v.offset[0] === '+' ? minutes : -minutes) * 60000 === Date.parse(v.releaseAt);
}
export function parseMorningSlot(v: unknown, scope: MorningScope): MorningSlot | null {
  if (!object(v) || !scopeValid(scope) || !uuid(v.id) || v.coupleId !== scope.coupleId
    || v.membershipEpoch !== scope.membershipEpoch || !uuid(v.senderId) || !uuid(v.recipientId)
    || v.senderId === v.recipientId || (v.senderId !== scope.userId && v.recipientId !== scope.userId)) return null;
  const sender = v.senderId === scope.userId;
  if (!exact(v, sender ? [...slotKeys, 'prepared'] : [...slotKeys, 'openedAt']) || (sender && typeof v.prepared !== 'boolean')
    || (!sender && v.openedAt !== null && (!iso(v.openedAt) || !iso(v.releaseAt)
      || v.openedAt < v.releaseAt || v.state !== 'available'))
    || !snapshot(v) || !positive(v.preferenceVersion) || !iso(v.createdAt)
    || Date.parse(v.createdAt) >= Date.parse(String(v.releaseAt))
    || !['sealed', 'available', 'missed'].includes(String(v.state))
    || (sender && v.state === 'available' && !v.prepared)
    || (sender && v.state === 'missed' && v.prepared)) return null;
  return v as MorningSlot;
}
function order(a: MorningCursor, b: MorningCursor): number {
  return a.releaseAt === b.releaseAt ? a.id.localeCompare(b.id) : a.releaseAt.localeCompare(b.releaseAt);
}
function cursor(v: unknown, edge: MorningSlot | undefined, flag: boolean): boolean {
  return flag ? !!edge && object(v) && exact(v, ['id', 'releaseAt'])
    && v.id === edge.id && v.releaseAt === edge.releaseAt : v === null;
}
export function parseMorningPage(v: unknown, scope: MorningScope, readId: string,
  direction: 'latest' | 'oldest' | 'before' | 'after', anchor?: MorningCursor): MorningPage | null {
  if (!object(v) || !exact(v, ['readId', 'serverNow', 'preferences', 'slots', 'hasOlder', 'hasNewer',
    'olderCursor', 'newerCursor', 'lastAvailableId']) || !uuid(readId) || v.readId !== readId || !iso(v.serverNow)
    || !scopeValid(scope) || !Array.isArray(v.preferences) || v.preferences.length > 2
    || !Array.isArray(v.slots) || v.slots.length > 30 || typeof v.hasOlder !== 'boolean'
    || typeof v.hasNewer !== 'boolean' || (v.lastAvailableId !== null && !uuid(v.lastAvailableId))) return null;
  if (!['latest', 'oldest', 'before', 'after'].includes(direction)
    || (direction === 'latest' && v.hasNewer) || (direction === 'oldest' && v.hasOlder)) return null;
  const anchored = direction === 'before' || direction === 'after';
  if (anchored && (!anchor || !uuid(anchor.id) || !iso(anchor.releaseAt))) return null;
  const preferences = v.preferences.map(p => parseMorningPreference(p, scope));
  const slots = v.slots.map(s => parseMorningSlot(s, scope));
  if (preferences.some(p => !p) || slots.some(s => !s)) return null;
  const ps = preferences as Preference[], ss = slots as MorningSlot[];
  const participants = new Set([scope.userId]);
  ps.forEach(p => participants.add(p.userId));
  ss.forEach(s => { participants.add(s.senderId); participants.add(s.recipientId); });
  if (participants.size > 2 || new Set(ps.map(p => p.userId)).size !== ps.length
    || new Set(ss.map(s => s.id)).size !== ss.length) return null;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if ((i > 0 && order(ss[i - 1], s) <= 0)
      || (anchored && anchor && (direction === 'before' ? order(s, anchor) >= 0 : order(s, anchor) <= 0))
      || (s.openedAt == null && ((s.state === 'sealed') !== (s.releaseAt > v.serverNow)))) return null;
    if (s.id === v.lastAvailableId && (s.recipientId !== scope.userId || s.state !== 'available')) return null;
  }
  if (!cursor(v.olderCursor, ss.at(-1), v.hasOlder) || !cursor(v.newerCursor, ss[0], v.hasNewer)) return null;
  return v as MorningPage;
}
export function canonicalMorningSlot(old: MorningSlot, next: MorningSlot): MorningSlot | null {
  const immutable = slotKeys.filter(k => k !== 'state');
  if (immutable.some(k => old[k as keyof MorningSlot] !== next[k as keyof MorningSlot])
    || Object.hasOwn(old, 'openedAt') !== Object.hasOwn(next, 'openedAt')
    || (old.openedAt != null && old.openedAt !== next.openedAt)
    || (next.openedAt != null && (!iso(next.openedAt) || next.openedAt < next.releaseAt || next.state !== 'available'))
    || Object.hasOwn(old, 'prepared') !== Object.hasOwn(next, 'prepared')
    || (old.prepared === true && next.prepared !== true)
    || (old.state !== 'sealed' && next.state !== old.state)) return null;
  return next;
}
