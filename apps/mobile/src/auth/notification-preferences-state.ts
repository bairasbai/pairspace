import type { SessionContext } from './context';
import { record, uuid, sameDateContext } from './dates-state';
import { instant } from './partings-state';
export { record, uuid, sameDateContext, instant };
export type Category = 'care' | 'chat' | 'letter';
export type Quiet = Readonly<{ start: string; end: string; timezone: string }>;
export type NotificationFields = Readonly<{ care: boolean; chat: boolean; letter: boolean; quiet: Quiet | null }>;
export type NotificationPreferences = NotificationFields & Readonly<{ coupleId: string; userId: string; membershipEpoch: number; version: number; preview: 'generic' }>;
export type PolicyPreview = Readonly<{ allowedByPreferences: boolean; reason: 'disabled' | 'quiet_hours' | 'allowed'; category: Category; asOf: string; preferenceVersion: number; simulationOnly: true }>;
export const defaultNotificationFields: NotificationFields = Object.freeze({ care: false, chat: false, letter: false, quiet: null });
export type NotificationView = Readonly<{ available: boolean; busy: boolean; fields: NotificationFields;
  editingVersion: number | null; preferences: NotificationPreferences | null; checked: boolean; asOf: string | null;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  error: boolean; requiresRefresh: boolean; pending: NotificationFields | null; policyPreview: PolicyPreview | null }>;
export const emptyNotifications: NotificationView = { available: false, busy: false, fields: defaultNotificationFields, editingVersion: null,
  preferences: null, checked: false, asOf: null, status: 'idle', error: false, requiresRefresh: false, pending: null, policyPreview: null };
export const category = (v: unknown): v is Category => v === 'care' || v === 'chat' || v === 'letter';
export function validQuiet(v: unknown): v is Quiet | null {
  if (v === null) return true;
  if (!record(v) || Object.keys(v).sort().join(',') !== 'end,start,timezone'
    || typeof v.start !== 'string' || typeof v.end !== 'string' || typeof v.timezone !== 'string'
    || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(v.start) || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(v.end)
    || v.start === v.end || v.timezone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(v.timezone)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }).format(); return true; } catch { return false; }
}
export function validFields(v: unknown): v is NotificationFields {
  return record(v) && Object.keys(v).sort().join(',') === 'care,chat,letter,quiet'
    && typeof v.care === 'boolean' && typeof v.chat === 'boolean' && typeof v.letter === 'boolean' && validQuiet(v.quiet);
}
export function sameFields(a: NotificationFields, b: NotificationFields): boolean {
  return a.care === b.care && a.chat === b.chat && a.letter === b.letter
    && (a.quiet === null ? b.quiet === null : b.quiet !== null && a.quiet.start === b.quiet.start && a.quiet.end === b.quiet.end && a.quiet.timezone === b.quiet.timezone);
}
export function validPreferences(v: unknown, c: SessionContext): v is NotificationPreferences {
  return record(v) && c.state === 'ready' && Object.keys(v).sort().join(',') === 'care,chat,coupleId,letter,membershipEpoch,preview,quiet,userId,version'
    && v.coupleId === c.coupleId && v.userId === c.userId && v.membershipEpoch === c.membershipEpoch && v.preview === 'generic'
    && Number.isSafeInteger(v.version) && (v.version as number) >= 0 && (v.version as number) <= 2147483647
    && validFields({ care: v.care, chat: v.chat, letter: v.letter, quiet: v.quiet })
    && (v.version !== 0 || sameFields(v as NotificationPreferences, defaultNotificationFields));
}
export function validPreview(v: unknown, requested: Category): v is PolicyPreview {
  return record(v) && Object.keys(v).sort().join(',') === 'allowedByPreferences,asOf,category,preferenceVersion,reason,simulationOnly'
    && v.category === requested && v.simulationOnly === true && instant(v.asOf)
    && Number.isSafeInteger(v.preferenceVersion) && (v.preferenceVersion as number) >= 0 && (v.preferenceVersion as number) <= 2147483647
    && (v.preferenceVersion !== 0 || v.reason === 'disabled')
    && (v.reason === 'disabled' || v.reason === 'quiet_hours' || v.reason === 'allowed') && v.allowedByPreferences === (v.reason === 'allowed');
}
export function copyFields(v: NotificationFields): NotificationFields {
  return Object.freeze({ care: v.care, chat: v.chat, letter: v.letter, quiet: v.quiet && Object.freeze({ ...v.quiet }) });
}
