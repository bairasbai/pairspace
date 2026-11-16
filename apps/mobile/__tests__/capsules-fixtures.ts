import { createCapsulesController } from '../src/auth/capsules';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { Capsule } from '../src/auth/capsules-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const before = '2026-11-10T00:00:00.000Z', due = '2026-11-11T06:00:00.000Z';
export const schedule = { localDate: '2026-11-11', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
export const own: Capsule = { id: uuid(9), coupleId: context.coupleId, authorId: context.userId,
  membershipEpoch: 1, version: 1, createdAt: before, sealedAt: before, ...schedule, releaseAt: due, contentState: 'active' };
export const removed: Capsule = { ...own, version: 2, contentState: 'removed' };
export const resealed: Capsule = { ...own, version: 2, sealedAt: '2026-11-10T01:00:00.000Z',
  localDate: '2026-11-13', releaseAt: '2026-11-13T06:00:00.000Z' };
export const prose = 'Synthetic private capsule\n\nSynthetic second paragraph';
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status, headers });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status, headers });
export const list = (capsules: unknown[] = [], checkedAt = due) => envelope({ capsules, checkedAt, used: capsules.length, capacity: 1 });
export const ack = (capsule: unknown = own, replay = false, commandId = uuid(3), checkedAt = due) => envelope({ capsule, replay, commandId, checkedAt });
export const detail = (capsule: Capsule = own, text: unknown = prose, checkedAt = due) =>
  envelope({ capsule, checkedAt, ...(capsule.contentState === 'active' && checkedAt >= capsule.releaseAt ? { text } : {}) });
export function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve: (r: Response) => resolve(r) }; }
export async function settle() { for (let n = 0; n < 120; n++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
  const controller = createCapsulesController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setDraft(prose);
  return { controller, api: controller.actions, host, operation, discovery, command,
    set(value: InvitationHostSnapshot | null) { capture = value; },
    schedule(values = schedule) { for (const field of ['localDate', 'localTime', 'timezone', 'offset'] as const) controller.actions.setSchedule(field, values[field]); },
    async load(capsules: unknown[] = [], checkedAt = due) { operation.mockResolvedValueOnce(list(capsules, checkedAt)); await controller.actions.load(); } };
}
