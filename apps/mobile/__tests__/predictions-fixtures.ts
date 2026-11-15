import { createPredictionsController } from '../src/auth/predictions';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { Prediction } from '../src/auth/predictions-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const before = '2026-11-10T00:00:00.000Z', due = '2026-11-11T06:00:00.000Z';
export const schedule = { localDate: '2026-11-11', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
export const own: Prediction = { id: uuid(9), coupleId: context.coupleId, authorId: context.userId, recipientId: uuid(4),
  membershipEpoch: 1, version: 1, createdAt: before, ...schedule, releaseAt: due, contentState: 'active', openedAt: null, declinedAt: null };
export const incoming: Prediction = { ...own, id: uuid(8), authorId: uuid(4), recipientId: context.userId };
export const opened: Prediction = { ...incoming, version: 2, openedAt: due };
export const removed: Prediction = { ...opened, version: 3, contentState: 'removed' };
export const declined: Prediction = { ...incoming, version: 2, declinedAt: due };
export const ownOpened: Prediction = { ...own, version: 2, openedAt: due };
export const prose = 'Synthetic private prediction\n\nSynthetic second paragraph';
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status, headers });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status, headers });
export const list = (predictions: unknown[] = [], checkedAt = due) => envelope({ predictions, checkedAt, used: predictions.length, capacity: 100 });
export const ack = (prediction: unknown = own, replay = false, commandId = uuid(3), checkedAt = due) => envelope({ prediction, replay, commandId, checkedAt });
export const detail = (prediction: Prediction = opened, text: unknown = prose, checkedAt = due) =>
  envelope({ prediction, checkedAt, ...(prediction.contentState === 'active' ? { text } : {}) });
export function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve: (r: Response) => resolve(r) }; }
export async function settle() { for (let n = 0; n < 120; n++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
  const controller = createPredictionsController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setDraft(prose);
  return { controller, api: controller.actions, host, operation, discovery, command,
    set(value: InvitationHostSnapshot | null) { capture = value; },
    schedule(values = schedule) { for (const field of ['localDate', 'localTime', 'timezone', 'offset'] as const) controller.actions.setSchedule(field, values[field]); },
    async load(predictions: unknown[] = [], checkedAt = due) { operation.mockResolvedValueOnce(list(predictions, checkedAt)); await controller.actions.load(); } };
}
