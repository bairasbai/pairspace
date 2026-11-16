import { parseMorningPreference, resolveMorningChoice } from '../letters/morning.ts';

/** Internal metadata, never a stored body or a client-supplied authorization. */
export type Capsule = Readonly<{
  id: string; coupleId: string; authorId: string; membershipEpoch: number; version: number;
  createdAt: string; sealedAt: string; releaseAt: string;
  localDate: string; localTime: string; timezone: string; offset: string;
  contentState: 'active' | 'removed';
}>;
export type CapsuleScope = Readonly<{ coupleId: string; userId: string; membershipEpoch: number }>;
export type CapsuleSchedule = Readonly<{
  localDate: string; localTime: string; timezone: string; offset: string; releaseAt: string;
}>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const count = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 2147483646;
const instant = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** A calendar-year suggestion, not 365 elapsed days. Leap day clamps to February28. */
export function nextCapsuleYear(localDate: unknown): string | null {
  if (typeof localDate !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(localDate)) return null;
  const date = new Date(localDate + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== localDate) return null;
  const year = Number(localDate.slice(0, 4)) + 1;
  return `${year}${localDate.slice(4) === '-02-29' ? '-02-28' : localDate.slice(4)}`;
}

/** Caller supplies server time; an explicit zone/offset disambiguates DST folds. */
export function parseCapsuleSchedule(input: unknown, trustedNow: string): CapsuleSchedule | null {
  if (!record(input) || Object.keys(input).sort().join(',') !== 'localDate,localTime,offset,timezone' || !instant(trustedNow)) return null;
  const preference = parseMorningPreference(input.timezone, input.localTime);
  const choice = resolveMorningChoice(input.localDate, input.localTime, input.timezone, input.offset);
  if (!preference || !choice) return null;
  const parts = new Intl.DateTimeFormat('en', { timeZone: preference.timezone, calendar: 'iso8601',
    numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(trustedNow));
  const today = ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('-');
  if (String(input.localDate) <= today || choice.releaseAt <= trustedNow) return null;
  return { localDate: input.localDate as string, localTime: preference.localTime,
    timezone: preference.timezone, offset: choice.offset, releaseAt: choice.releaseAt };
}

export function normalizeCapsuleBody(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8000 || /\r(?!\n)/.test(value)
    || /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return null;
  const normalized = value.normalize('NFC').replace(/\r\n/g, '\n');
  if (/\p{Cc}/u.test(normalized.replace(/\n/g, ''))) return null;
  const body = normalized.trim();
  return body && [...body].length <= 2000 ? body : null;
}

/** Owner-only structural scope check. Auth and current membership MUST be checked by API. */
export function validCapsule(value: unknown, scope: CapsuleScope): value is Capsule {
  if (!record(value) || Object.keys(value).sort().join(',') !==
    'authorId,contentState,coupleId,createdAt,id,localDate,localTime,membershipEpoch,offset,releaseAt,sealedAt,timezone,version'
    || !uuid(scope.coupleId) || !uuid(scope.userId) || !count(scope.membershipEpoch)
    || !uuid(value.id) || value.authorId !== scope.userId || value.coupleId !== scope.coupleId
    || value.membershipEpoch !== scope.membershipEpoch || !count(value.version)
    || !instant(value.createdAt) || !instant(value.sealedAt) || value.sealedAt < value.createdAt
    || !instant(value.releaseAt) || (value.contentState !== 'active' && value.contentState !== 'removed')
    || value.version < 1 + Number(value.sealedAt !== value.createdAt) + Number(value.contentState === 'removed')
    || (value.contentState === 'active' && value.version === 2147483646)
    || parseMorningPreference(value.timezone, value.localTime)?.timezone !== value.timezone) return false;
  const schedule = parseCapsuleSchedule({ localDate: value.localDate, localTime: value.localTime,
    timezone: value.timezone, offset: value.offset }, value.sealedAt);
  return schedule !== null && schedule.releaseAt === value.releaseAt;
}

/** Even the author cannot read before release. Never fetch body before this gate. */
export function mayReadCapsule(value: unknown, scope: CapsuleScope, trustedNow: string): boolean {
  return instant(trustedNow) && validCapsule(value, scope)
    && value.contentState === 'active' && trustedNow >= value.releaseAt;
}

/** Metadata-only response. A ready capsule still requires a separate authorized body read. */
export function capsuleStatus(value: unknown, scope: CapsuleScope, trustedNow: string): 'sealed' | 'ready' | 'removed' | null {
  if (!instant(trustedNow) || !validCapsule(value, scope) || trustedNow < value.sealedAt) return null;
  if (value.contentState === 'removed') return 'removed';
  return trustedNow >= value.releaseAt ? 'ready' : 'sealed';
}

/** Replace with newly supplied text only BEFORE old release, never return the old body.
 * Storage must validate body and atomically replace it with these CAS metadata.
 */
export function resealCapsule(value: unknown, scope: CapsuleScope, trustedNow: string,
  expectedVersion: number, scheduleInput: unknown, confirm: boolean): Capsule | null {
  if (confirm !== true || !instant(trustedNow) || !validCapsule(value, scope)
    || value.contentState !== 'active' || value.version !== expectedVersion || value.version >= 2147483645
    || trustedNow < value.sealedAt || trustedNow >= value.releaseAt) return null;
  const schedule = parseCapsuleSchedule(scheduleInput, trustedNow);
  if (!schedule) return null;
  return { ...value, ...schedule, sealedAt: trustedNow, version: value.version + 1 };
}

/** Terminal logical removal; persistence must erase the body in the same transaction. */
export function removeCapsule(value: unknown, scope: CapsuleScope, trustedNow: string,
  expectedVersion: number, confirm: boolean): Capsule | null {
  if (confirm !== true || !instant(trustedNow) || !validCapsule(value, scope)
    || trustedNow < value.sealedAt || value.contentState !== 'active'
    || value.version !== expectedVersion || value.version >= 2147483646) return null;
  return { ...value, contentState: 'removed', version: value.version + 1 };
}

/** Body-free receipt/current consistency. Storage enforces each intervening +1 transition. */
export function followsCapsule(old: unknown, next: unknown, scope: CapsuleScope): boolean {
  if (!validCapsule(old, scope) || !validCapsule(next, scope)) return false;
  const fixed = ['id', 'coupleId', 'authorId', 'membershipEpoch', 'createdAt'] as const;
  if (!fixed.every(key => old[key] === next[key]) || next.version < old.version || next.sealedAt < old.sealedAt) return false;
  if (old.contentState === 'removed' || next.version === old.version) {
    return Object.keys(old).every(key => old[key as keyof Capsule] === next[key as keyof Capsule]);
  }
  if (next.version === old.version + 1) {
    if (next.contentState === 'removed') {
      return (['sealedAt', 'releaseAt', 'localDate', 'localTime', 'timezone', 'offset'] as const)
        .every(key => old[key] === next[key]);
    }
    return next.sealedAt < old.releaseAt;
  }
  // Two steps ending in removal leave room for exactly one reseal.
  if (next.version === old.version + 2 && next.contentState === 'removed') return next.sealedAt < old.releaseAt;
  // Multiple reseals may legitimately extend the previous deadline before it passes.
  return true;
}
