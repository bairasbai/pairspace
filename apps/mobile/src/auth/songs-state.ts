import { normalizeSongLink } from '../../../../packages/domain/songs/link';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { normalizeSongExplanation } from '../../../../packages/domain/songs/text';
import type { SessionContext } from './context';
export type SharedSong = Readonly<{ id: string; coupleId: string; creatorId: string;
  membershipEpoch: number; title: string; explanation: string; musicUrl?: string; createdAt: string; version: number }>;
export type SongsView = Readonly<{ userId: string | null; editing: Readonly<{ id: string; version: number }> | null; available: boolean; busy: boolean; draft: string; explanation: string; musicUrl: string; consent: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  songs: readonly SharedSong[]; checked: boolean; error: boolean; requiresRefresh: boolean;
  pending: Readonly<{ editing?: Readonly<{ id: string; version: number }> | null; title: string; explanation: string; musicUrl?: string }> | null }>;
export const emptySongs: SongsView = { userId: null, editing: null, available: false, busy: false, draft: '', explanation: '', musicUrl: '', consent: false,
  status: 'idle', songs: [], checked: false, error: false, requiresRefresh: false, pending: null };
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function sameSongContext(a: SessionContext, b: SessionContext) {
  return a.state === 'ready' && b.state === 'ready' && a.sessionId === b.sessionId
    && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
function instant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
export function validSong(v: unknown, context: SessionContext): v is SharedSong {
  if (!record(v) || context.state !== 'ready'
    || Object.keys(v).filter(key => key !== 'musicUrl').sort().join(',') !== 'coupleId,createdAt,creatorId,explanation,id,membershipEpoch,title,version') return false;
  if ('musicUrl' in v && (typeof v.musicUrl !== 'string' || !normalizeSongLink(v.musicUrl).ok)) return false;
  const title = normalizeTaskTitle(v.title), body = normalizeSongExplanation(v.explanation);
  return Number.isInteger(v.version) && (v.version as number) >= 1 && (v.version as number) <= 2147483647 && uuid(v.id) && uuid(v.creatorId) && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch && title.ok && title.text === v.title
    && body.ok && body.text === v.explanation && instant(v.createdAt);
}
export function songOrder(a: SharedSong, b: SharedSong) {
  return a.createdAt === b.createdAt ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    : a.createdAt > b.createdAt ? -1 : 1;
}
