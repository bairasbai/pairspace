import { createHardQuestionsController } from '../src/auth/hard-questions';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { HardQuestion } from '../src/auth/hard-questions-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const own: HardQuestion = { id: uuid(9), coupleId: context.coupleId, authorId: context.userId, recipientId: uuid(4),
  membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', contentState: 'active', decisionState: 'sealed' };
export const incoming: HardQuestion = { ...own, id: uuid(8), authorId: uuid(4), recipientId: context.userId };
export const opened: HardQuestion = { ...incoming, version: 2, decisionState: 'opened', openedAt: '2026-11-10T00:01:00.000Z' };
export const removed: HardQuestion = { ...opened, version: 3, contentState: 'removed' };
export const declined: HardQuestion = { ...incoming, version: 2, decisionState: 'declined' };
export const ownOpened: HardQuestion = { ...own, version: 2, decisionState: 'opened', openedAt: opened.openedAt };
export const prose = 'Synthetic private question\n\nSynthetic second paragraph';
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status });
export const list = (questions: unknown[] = [], checkedAt = '2026-11-11T00:00:00.000Z') => envelope({ questions, checkedAt, used: questions.length, capacity: 100 });
export const ack = (question: unknown = own, replay = false, commandId = uuid(3)) => envelope({ question, replay, commandId });
export const openAck = (question: HardQuestion = opened, replay = false, text: unknown = prose, commandId = uuid(3)) =>
  envelope({ question, replay, commandId, checkedAt: '2026-11-11T00:00:00.000Z', ...(question.contentState === 'active' ? { text } : {}) });
export const detail = (question: HardQuestion = opened, text: unknown = prose, checkedAt = '2026-11-11T00:00:00.000Z') =>
  envelope({ question, checkedAt, ...(question.contentState === 'active' ? { text } : {}) });
export function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve: (r: Response) => resolve(r) }; }
export async function settle() { for (let n = 0; n < 80; n++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
  const controller = createHardQuestionsController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setDraft(prose);
  return { controller, api: controller.actions, host, operation, discovery, command,
    set(value: InvitationHostSnapshot | null) { capture = value; },
    async load(questions: unknown[] = []) { operation.mockResolvedValueOnce(list(questions)); await controller.actions.load(); } };
}
