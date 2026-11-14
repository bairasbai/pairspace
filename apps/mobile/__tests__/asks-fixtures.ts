import { createAsksController } from '../src/auth/asks';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { AskQuestion } from '../src/auth/asks-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const own: AskQuestion = { id: uuid(9), coupleId: uuid(2), authorId: uuid(1), recipientId: uuid(4), membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', questionState: 'active', responseState: 'waiting', question: 'How are you?' };
export const incoming: AskQuestion = { ...own, id: uuid(8), authorId: uuid(4), recipientId: uuid(1) };
export const answered: AskQuestion = { ...incoming, version: 2, responseState: 'answered', answer: 'Good', answeredAt: '2026-11-10T00:01:00.000Z' };
export const skipped: AskQuestion = { ...incoming, version: 2, responseState: 'skipped' };
export const withdrawn: AskQuestion = { id: own.id, coupleId: own.coupleId, authorId: own.authorId, recipientId: own.recipientId, membershipEpoch: 1, sequence: 1, version: 2, createdAt: own.createdAt, questionState: 'removed', responseState: 'withdrawn' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (error: string, status: number) => new Response(JSON.stringify({ ok: false, error }), { status });
export const list = (questions: unknown[] = [], checkedAt = '2026-11-11T00:00:00.000Z') => envelope({ questions, checkedAt, capacity: 100, used: questions.length });
export const ack = (question: unknown = own, replay = false, commandId = uuid(3)) => envelope({ question, replay, commandId });
export async function settle() { for (let i = 0; i < 45; i++)
    await Promise.resolve(); }
export function fixture() {
    let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
    const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => { }) };
    const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
    const controller = createAsksController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host, r => r.url.endsWith('/context') ? discovery() : operation(r), command);
    controller.sync();
    controller.actions.setCreate(own.question!);
    return { controller, api: controller.actions, host, discovery, operation, command, set: (value: InvitationHostSnapshot | null) => { capture = value; }, async load(questions: unknown[] = []) { operation.mockResolvedValueOnce(list(questions)); await controller.actions.load(); } };
}
