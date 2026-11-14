import { createLoveWordsController } from '../src/auth/love-words';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { LoveWord } from '../src/auth/love-words-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const word: Extract<LoveWord, {
    state: 'active';
}> = { id: uuid(9), coupleId: uuid(2), authorId: uuid(1), membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', state: 'active', word: 'Sun', meaning: 'Warmth', saidWhen: 'Morning', edited: false };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (error: string, status: number) => new Response(JSON.stringify({ ok: false, error }), { status });
export const list = (words: unknown[] = [], checkedAt = '2026-11-11T00:00:00.000Z') => envelope({ words, checkedAt, capacity: 100, used: words.length });
export const ack = (value: unknown = word, replay = false, commandId = uuid(3)) => envelope({ word: value, replay, commandId });
export const deleted = { id: word.id, coupleId: word.coupleId, authorId: word.authorId, membershipEpoch: 1, sequence: 1, version: 2, createdAt: word.createdAt, state: 'deleted' as const };
export async function settle() { for (let i = 0; i < 45; i++)
    await Promise.resolve(); }
export function fixture() {
    let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
    const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => { }) };
    const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
    const controller = createLoveWordsController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host, r => r.url.endsWith('/context') ? discovery() : operation(r), command);
    controller.sync();
    for (const key of ['word', 'meaning', 'saidWhen'] as const)
        controller.actions.setCreateField(key, word.state === 'active' ? word[key] : '');
    return { controller, api: controller.actions, host, discovery, operation, command, set: (value: InvitationHostSnapshot | null) => { capture = value; },
        async load(words: unknown[] = []) { operation.mockResolvedValueOnce(list(words)); await controller.actions.load(); } };
}
