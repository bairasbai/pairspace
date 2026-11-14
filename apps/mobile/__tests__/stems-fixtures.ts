import { createStemsController } from '../src/auth/stems';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { StemRound } from '../src/auth/stems-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const own: StemRound = { id: uuid(9), coupleId: uuid(2), authorId: uuid(1), recipientId: uuid(4), membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', authorTextState: 'active', phase: 'waiting', recipientTextState: 'absent', authorContinuation: 'Own', beginning: 'How are you?' };
const { authorContinuation: _hidden, ...shared } = own;
export const incoming: StemRound = { ...shared, id: uuid(8), authorId: uuid(4), recipientId: uuid(1) };
export const completed: StemRound = { ...incoming, version: 2, phase: 'completed', recipientTextState: 'active', authorContinuation: 'Other', recipientContinuation: 'Good', completedAt: '2026-11-10T00:01:00.000Z' };
export const skipped: StemRound = { ...incoming, version: 2, phase: 'skipped' };
export const withdrawn: StemRound = { id: own.id, coupleId: own.coupleId, authorId: own.authorId, recipientId: own.recipientId, membershipEpoch: 1, sequence: 1, version: 2, createdAt: own.createdAt, authorTextState: 'removed', phase: 'withdrawn', recipientTextState: 'absent' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (error: string, status: number) => new Response(JSON.stringify({ ok: false, error }), { status });
export const list = (rounds: unknown[] = [], checkedAt = '2026-11-11T00:00:00.000Z') => envelope({ rounds, checkedAt, capacity: 100, used: rounds.length });
export const ack = (round: unknown = own, replay = false, commandId = uuid(3)) => envelope({ round, replay, commandId });
export async function settle() {
    for (let i = 0; i < 45; i++)
        await Promise.resolve();
}
export function fixture() {
    let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
    const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => { }) };
    const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
    const controller = createStemsController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host, r => r.url.endsWith('/context') ? discovery() : operation(r), command);
    controller.sync();
    controller.actions.setCreate('beginning', own.beginning!);
    controller.actions.setCreate('ownContinuation', 'Own');
    return { controller, api: controller.actions, host, discovery, operation, command, set: (value: InvitationHostSnapshot | null) => { capture = value; }, async load(rounds: unknown[] = []) { operation.mockResolvedValueOnce(list(rounds)); await controller.actions.load(); } };
}
