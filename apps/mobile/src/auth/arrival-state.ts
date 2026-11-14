import { parseMorningPreference, resolveMorningChoice } from '../../../../packages/domain/letters/morning';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import type { SessionContext } from './context';
import { record, uuid, sameDateContext } from './dates-state';
import { instant } from './partings-state';
export { record, uuid, sameDateContext, instant };
export type ArrivalFields = Readonly<{ label: string; localDate: string; localTime: string; timezone: string; offset: string }>;
export type ArrivalPlan = ArrivalFields & Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number; arrivesAt: string; createdAt: string; version: number }>;
export const blankArrival: ArrivalFields = { label: '', localDate: '', localTime: '', timezone: '', offset: '' };
export type ArrivalView = Readonly<{ available: boolean; busy: boolean; fields: ArrivalFields;
  editingVersion: number | null; plan: ArrivalPlan | null; checked: boolean; asOf: string | null;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  error: boolean; requiresRefresh: boolean; pending: ArrivalFields | null }>;
export const emptyArrival: ArrivalView = { available: false, busy: false, fields: blankArrival, editingVersion: null,
  plan: null, checked: false, asOf: null, status: 'idle', error: false, requiresRefresh: false, pending: null };
export function parseArrivalFields(v: ArrivalFields): ArrivalFields | null {
  const label = v.label.trim() === '' ? { ok: true as const, text: '' } : normalizeTaskTitle(v.label), preference = parseMorningPreference(v.timezone, v.localTime);
  if (!label.ok || !preference || !resolveMorningChoice(v.localDate, v.localTime, v.timezone, v.offset)) return null;
  return { ...v, label: label.text, timezone: preference.timezone };
}
export function validArrival(v: unknown, c: SessionContext): v is ArrivalPlan {
  if (!record(v) || c.state !== 'ready' || Object.keys(v).sort().join(',') !== 'arrivesAt,coupleId,createdAt,creatorId,id,label,localDate,localTime,membershipEpoch,offset,timezone,version') return false;
  if (typeof v.label !== 'string' || typeof v.localDate !== 'string' || typeof v.localTime !== 'string' || typeof v.timezone !== 'string' || typeof v.offset !== 'string') return false;
  const fields = parseArrivalFields(v as ArrivalPlan);
  return !!fields && fields.label === v.label && fields.timezone === v.timezone && uuid(v.id) && uuid(v.creatorId)
    && v.coupleId === c.coupleId && v.membershipEpoch === c.membershipEpoch && Number.isSafeInteger(v.version)
    && (v.version as number) > 0 && (v.version as number) <= 2147483647 && instant(v.createdAt) && instant(v.arrivesAt)
    && resolveMorningChoice(v.localDate, v.localTime, v.timezone, v.offset)?.releaseAt === v.arrivesAt;
}
export function sameArrival(a: ArrivalPlan, b: ArrivalPlan): boolean {
  return Object.keys(a).every(key => a[key as keyof ArrivalPlan] === b[key as keyof ArrivalPlan]);
}
