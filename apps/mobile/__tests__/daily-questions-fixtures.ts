import { createDailyQuestionsController } from '../src/auth/daily-questions';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { DailyEntry, DailySlot, DailyAnswerMetadata } from '../src/auth/daily-questions-state';
import { dailyPrompt } from '../../../packages/domain/daily-question/catalog';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const start = '2026-11-10T12:00:00.000Z', later = '2026-11-10T13:00:00.000Z', tomorrow = '2026-11-11T00:00:00.000Z';
export const slot: DailySlot = { id: uuid(7), coupleId: context.coupleId, membershipEpoch: 1,
 participantIds: [context.userId, uuid(4)], day: '2026-11-10', timezone: 'UTC', createdAt: start, ...dailyPrompt('2026-11-10')! };
export const own: DailyAnswerMetadata = { id: uuid(9), slotId: slot.id, coupleId: context.coupleId, membershipEpoch: 1,
 authorId: context.userId, version: 1, createdAt: start, editedAt: start, contentState: 'active', removedAt: null };
export const partner: DailyAnswerMetadata = { ...own, id: uuid(8), authorId: uuid(4) };
export const edited: DailyAnswerMetadata = { ...own, version: 2, editedAt: later };
export const removed: DailyAnswerMetadata = { ...own, version: 2, contentState: 'removed', removedAt: later };
export const prose = 'Synthetic daily answer\nSecond paragraph';
export const entry = (answers: readonly DailyAnswerMetadata[] = [own, partner], pinned = slot): DailyEntry => ({ slot: pinned, answers });
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status, headers });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status, headers });
export const today = (checkedAt = start) => ({ day: checkedAt.slice(0, 10), timezone: 'UTC', ...dailyPrompt(checkedAt.slice(0, 10))! });
export const page = (slots: readonly DailyEntry[] = [], checkedAt = start, hasMore = false) => envelope({ slots,
 today: today(checkedAt), checkedAt, hasMore, nextBeforeDay: hasMore ? slots[slots.length - 1].slot.day : null });
export const ack = (answer: DailyAnswerMetadata = own, replay = false, commandId = uuid(3), checkedAt = start, pinned = slot) => envelope({ slot: pinned, answer, commandId, replay, checkedAt });
export const detail = (answer: DailyAnswerMetadata = own, text: unknown = prose, checkedAt = start, pinned = slot) => envelope({ slot: pinned, answer, checkedAt, ...(text === undefined ? {} : { text }) });
export function history(count = 100): DailyEntry[] {
 return Array.from({ length: count }, (_, index) => {
  const at = new Date(Date.parse(start) - index * 86400000).toISOString(), day = at.slice(0, 10);
  const pinned: DailySlot = { ...slot, id: uuid(100 + index), day, createdAt: at, ...dailyPrompt(day)! };
  return { slot: pinned, answers: [{ ...own, id: uuid(1000 + index), slotId: pinned.id, createdAt: at, editedAt: at }] };
 });
}
export function deferred() { let resolve!: (response: Response) => void, reject!: (reason: Error) => void;
 const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export async function settle() { for (let n = 0; n < 120; n++) await Promise.resolve(); }
export function fixture() {
 let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
 const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
 const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_request: Request) => ack()), command = jest.fn(() => uuid(3));
 const controller = createDailyQuestionsController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
  request => request.url.endsWith('/context') ? discovery() : operation(request), command);
 controller.sync(); controller.actions.setDraft(prose);
 return { controller, api: controller.actions, host, discovery, operation, command,
  set(value: InvitationHostSnapshot | null) { capture = value; },
  async refresh(slots: readonly DailyEntry[] = [], checkedAt = start, hasMore = false) {
   operation.mockResolvedValueOnce(page(slots, checkedAt, hasMore)); await controller.actions.refresh();
  } };
}
