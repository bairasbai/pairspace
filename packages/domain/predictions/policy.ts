import { parseMorningPreference, resolveMorningChoice } from '../letters/morning.ts';

/** Internal domain metadata only. Never pass stored bodies into list/ACK projections. */
export type Prediction = Readonly<{
  id: string; coupleId: string; authorId: string; recipientId: string;
  membershipEpoch: number; version: number; createdAt: string;
  releaseAt: string; timezone: string; localDate: string; localTime: string; offset: string; contentState: 'active' | 'removed';
  openedAt: string | null;
}>;
export type PredictionScope = Readonly<{ coupleId: string; userId: string; membershipEpoch: number }>;
export type PredictionSchedule = Readonly<{
  localDate: string; localTime: string; timezone: string; offset: string; releaseAt: string;
}>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const epoch = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 2147483646;
const instant = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function canonicalZone(v: unknown): v is string {
  return typeof v === 'string' && parseMorningPreference(v, '00:00')?.timezone === v;
}

/** No default timezone or clock: caller must supply an authoritative server instant. */
export function parsePredictionSchedule(input: unknown, trustedNow: string): PredictionSchedule | null {
  if (!record(input) || Object.keys(input).sort().join(',') !== 'localDate,localTime,offset,timezone' || !instant(trustedNow)) return null;
  const preference = parseMorningPreference(input.timezone, input.localTime);
  const choice = resolveMorningChoice(input.localDate, input.localTime, input.timezone, input.offset);
  if (!preference || !choice) return null;
  const parts = new Intl.DateTimeFormat('en', { timeZone: preference.timezone, calendar: 'iso8601',
    numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(trustedNow));
  const today = ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('-');
  // Later today is not a prediction. A future calendar day must also be a future instant.
  if (String(input.localDate) <= today || choice.releaseAt <= trustedNow) return null;
  return { localDate: input.localDate as string, localTime: preference.localTime,
    timezone: preference.timezone, offset: choice.offset, releaseAt: choice.releaseAt };
}

export function normalizePredictionBody(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8000
    || /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return null;
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (/\p{Cc}/u.test(normalized.replace(/\n/g, ''))) return null;
  const body = normalized.trim();
  return body && [...body].length <= 2000 ? body : null;
}

/** Structural + scope gate only, NOT authentication/current membership verification. */
export function validPrediction(value: unknown, scope: PredictionScope): value is Prediction {
  if (!record(value) || Object.keys(value).sort().join(',') !==
    'authorId,contentState,coupleId,createdAt,id,localDate,localTime,membershipEpoch,offset,openedAt,recipientId,releaseAt,timezone,version'
    || !uuid(scope.coupleId) || !uuid(scope.userId) || !epoch(scope.membershipEpoch)
    || !uuid(value.id) || !uuid(value.authorId) || !uuid(value.recipientId) || value.authorId === value.recipientId
    || value.coupleId !== scope.coupleId || value.membershipEpoch !== scope.membershipEpoch
    || ![value.authorId, value.recipientId].includes(scope.userId)
    || !instant(value.createdAt) || !instant(value.releaseAt) || value.releaseAt <= value.createdAt
    || !canonicalZone(value.timezone) || !['active', 'removed'].includes(String(value.contentState))) return false;
  const schedule = parsePredictionSchedule({ localDate: value.localDate, localTime: value.localTime,
    timezone: value.timezone, offset: value.offset }, value.createdAt);
  if (!schedule || schedule.releaseAt !== value.releaseAt) return false;
  if (value.openedAt !== null && (!instant(value.openedAt) || value.openedAt < value.releaseAt)) return false;
  return value.version === 1 + Number(value.openedAt !== null) + Number(value.contentState === 'removed');
}

/** No content is returned. The future API must authorize BEFORE fetching a body. */
export function mayReadPrediction(value: unknown, scope: PredictionScope, trustedNow: string): boolean {
  return instant(trustedNow) && validPrediction(value, scope) && trustedNow >= value.createdAt
    && value.contentState === 'active' && (value.authorId === scope.userId || trustedNow >= value.releaseAt);
}

/** Receipt is not a gate for visibility; reading must never implicitly mutate it. */
export function acknowledgePrediction(value: unknown, scope: PredictionScope, trustedNow: string,
  expectedVersion: number, confirm: boolean): Prediction | null {
  if (!confirm || !mayReadPrediction(value, scope, trustedNow) || !validPrediction(value, scope)
    || scope.userId !== value.recipientId || value.openedAt !== null || value.version !== expectedVersion) return null;
  return { ...value, openedAt: trustedNow, version: value.version + 1 };
}

/** Logical removal is terminal; persistence must erase the body in the same transaction. */
export function removePrediction(value: unknown, scope: PredictionScope,
  expectedVersion: number, confirm: boolean): Prediction | null {
  if (!confirm || !validPrediction(value, scope) || scope.userId !== value.authorId
    || value.contentState !== 'active' || value.version !== expectedVersion) return null;
  return { ...value, contentState: 'removed', version: value.version + 1 };
}

/** Refuse stale/rewritten metadata in future clients. Inputs must both validate first. */
export function followsPrediction(old: unknown, next: unknown, scope: PredictionScope): boolean {
  if (!validPrediction(old, scope) || !validPrediction(next, scope)) return false;
  const fixed = ['id', 'coupleId', 'authorId', 'recipientId', 'membershipEpoch', 'createdAt', 'releaseAt', 'timezone', 'localDate', 'localTime', 'offset'] as const;
  if (!fixed.every(key => old[key] === next[key]) || next.version < old.version
    || (old.contentState === 'removed' && next.contentState !== 'removed')
    || (old.openedAt !== null && old.openedAt !== next.openedAt)) return false;
  // Once removed, no later receipt may appear, even with a higher version.
  if (old.contentState === 'removed' && old.openedAt !== next.openedAt) return false;
  return next.version === old.version + Number(old.openedAt !== next.openedAt)
    + Number(old.contentState !== next.contentState);
}
