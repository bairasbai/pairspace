import { createDisputesController } from '../src/auth/disputes';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { DisputeMetadata } from '../src/auth/disputes-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const before = '2026-11-10T00:00:00.000Z', due = '2026-11-10T21:00:00.000Z';
export const own: DisputeMetadata = { id: uuid(9), coupleId: context.coupleId, authorId: context.userId, recipientId: uuid(4),
  membershipEpoch: 1, version: 1, createdAt: before, judgeDate: '2026-11-11', timezone: 'Europe/Moscow', contentState: 'active',
  decisionState: 'invited', joinedAt: null, declinedAt: null, resolvedAt: null, resolvedBy: null, winnerId: null, removedAt: null };
export const incoming = { ...own, authorId: uuid(4), recipientId: context.userId };
export const joined = { ...own, version: 2, decisionState: 'joined' as const, joinedAt: before };
export const resolved = { ...joined, version: 3, decisionState: 'resolved' as const, resolvedAt: due, resolvedBy: context.userId, winnerId: null };
export const removed = { ...own, version: 2, contentState: 'removed' as const, removedAt: due };
export const prose = 'Synthetic shared claim\n\nSecond paragraph', condition = 'Optional shared activity';
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status, headers });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status, headers });
export const list = (disputes: unknown[] = [], checkedAt = before) => envelope({ disputes, checkedAt, used: disputes.length, capacity: 100 });
export const ack = (dispute: unknown = own, replay = false, commandId = uuid(3), checkedAt = before) => envelope({ dispute, replay, commandId, checkedAt });
export const detail = (dispute: DisputeMetadata = own, claim: unknown = prose, checkedAt = before, optional: unknown = condition) =>
  envelope({ dispute, checkedAt, ...(dispute.contentState === 'active' ? { claim, condition: optional } : {}) });
export function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; }
export async function settle() { for (let n = 0; n < 120; n++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
  const controller = createDisputesController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setClaim(prose); controller.actions.setCondition(condition);
  return { controller, api: controller.actions, host, operation, discovery, command,
    set(value: InvitationHostSnapshot | null) { capture = value; },
    schedule() { controller.actions.setJudgeDate(own.judgeDate); controller.actions.setTimezone(own.timezone); },
    async load(disputes: unknown[] = [], checkedAt = before) { operation.mockResolvedValueOnce(list(disputes, checkedAt)); await controller.actions.refresh(); },
    async read(dispute: DisputeMetadata = own, checkedAt = before) { operation.mockResolvedValueOnce(detail(dispute, prose, checkedAt)); await controller.actions.read(dispute.id); } };
}
