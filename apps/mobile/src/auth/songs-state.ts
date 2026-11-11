import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { normalizeSongExplanation } from '../../../../packages/domain/songs/text';
import type { SessionContext } from './context';
export type SharedSong = Readonly<{ id: string; coupleId: string; creatorId: string;
  membershipEpoch: number; title: string; explanation: string; createdAt: string }>;
export type SongsView = Readonly<{ available: boolean; busy: boolean; draft: string; explanation: string; consent: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  songs: readonly SharedSong[]; checked: boolean; error: boolean; requiresRefresh: boolean;
  pending: Readonly<{ title: string; explanation: string }> | null }>;
export const emptySongs: SongsView = { available: false, busy: false, draft: '', explanation: '', consent: false,
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
    || Object.keys(v).sort().join(',') !== 'coupleId,createdAt,creatorId,explanation,id,membershipEpoch,title') return false;
  const title = normalizeTaskTitle(v.title), body = normalizeSongExplanation(v.explanation);
  return uuid(v.id) && uuid(v.creatorId) && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch && title.ok && title.text === v.title
    && body.ok && body.text === v.explanation && instant(v.createdAt);
}
export function songOrder(a: SharedSong, b: SharedSong) {
  return a.createdAt === b.createdAt ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    : a.createdAt > b.createdAt ? -1 : 1;
}
