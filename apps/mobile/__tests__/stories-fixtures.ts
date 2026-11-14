import { createStoriesController } from '../src/auth/stories';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { StoryMetadata } from '../src/auth/stories-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const own: StoryMetadata = { id: uuid(9), coupleId: context.coupleId, topicAuthorId: context.userId, storyAuthorId: uuid(4),
  membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', topicState: 'active', storyState: 'waiting', topic: 'A synthetic story topic' };
export const incoming: StoryMetadata = { ...own, id: uuid(8), topicAuthorId: uuid(4), storyAuthorId: context.userId };
export const told: StoryMetadata = { ...incoming, version: 2, storyState: 'told', toldAt: '2026-11-10T00:01:00.000Z' };
export const declined: StoryMetadata = { ...incoming, version: 2, storyState: 'declined' };
export const removed: StoryMetadata = { ...told, version: 3, storyState: 'story_removed' };
export const prose = 'Synthetic opening paragraph\n\nSynthetic second paragraph';
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status });
export const list = (stories: unknown[] = [], checkedAt = '2026-11-11T00:00:00.000Z') => envelope({ stories, checkedAt, capacity: 100, used: stories.length });
export const ack = (story: unknown = own, replay = false, commandId = uuid(3)) => envelope({ story, replay, commandId });
export const detail = (story: unknown = told, body: unknown = prose, checkedAt = '2026-11-11T00:00:00.000Z') => envelope({ story, checkedAt, ...(body !== undefined ? { body } : {}) });
export async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
export function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve: (r: Response) => resolve(r) }; }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
  const controller = createStoriesController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setTopic(own.topic!);
  return { controller, api: controller.actions, host, discovery, operation, command,
    set(value: InvitationHostSnapshot | null) { capture = value; },
    async load(stories: unknown[] = []) { operation.mockResolvedValueOnce(list(stories)); await controller.actions.load(); } };
}
