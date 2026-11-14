import { createSharedDoingsController } from '../src/auth/shared-doings';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { SharedDoing } from '../src/auth/shared-doings-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const own = { id: uuid(9), coupleId: context.coupleId, authorId: context.userId, recipientId: uuid(4), membershipEpoch: 1,
  sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', contentState: 'active', decisionState: 'invited', title: 'Synthetic course', kind: 'course', parts: 2, authorAt: 0 } as const satisfies SharedDoing;
export const incoming = { ...own, id: uuid(8), authorId: uuid(4), recipientId: context.userId } as const satisfies SharedDoing;
export const joined = { ...incoming, decisionState: 'joined', recipientAt: 0, version: 2 } as const satisfies SharedDoing;
export const complete = { ...joined, authorAt: 2, recipientAt: 2, version: 4 } as const satisfies SharedDoing;
export const declined = { ...incoming, decisionState: 'declined', version: 2 } as const satisfies SharedDoing;
export const withdrawn = { id: own.id, coupleId: own.coupleId, authorId: own.authorId, recipientId: own.recipientId,
  membershipEpoch: 1, sequence: 1, version: 2, createdAt: own.createdAt, contentState: 'removed', decisionState: 'withdrawn' } as const satisfies SharedDoing;
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status });
export const list = (doings: unknown[] = [], checkedAt = '2026-11-11T00:00:00.000Z') => envelope({ doings, checkedAt, used: doings.length, capacity: 100 });
export const ack = (doing: unknown = own, replay = false, commandId = uuid(3)) => envelope({ doing, replay, commandId });
export function deferred() { let resolve!: (r: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve: (r: Response) => resolve(r) }; }
export async function settle() { for (let n = 0; n < 100; n++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
  const controller = createSharedDoingsController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setTitle('Synthetic course'); controller.actions.setKind('course'); controller.actions.setParts('2');
  return { controller, api: controller.actions, host, operation, discovery, command, set(value: InvitationHostSnapshot | null) { capture = value; },
    async load(doings: unknown[] = []) { operation.mockResolvedValueOnce(list(doings)); await controller.actions.load(); } };
}
