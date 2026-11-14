import { baselineVisibility } from './visibility-baseline.fixture';
import { createSessionController } from '../src/auth/controller';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity = { userId: 'synthetic', sessionId: 'session' };
export const context = { state: 'ready', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const row = (n: number) => ({ id: uuid(n + 1000), coupleId: uuid(2), senderId: uuid(1), clientId: uuid(n + 2000),
  seq: n * 3, body: `Synthetic ${n}`, version: 1, createdAt: '2026-11-10T00:00:00Z' });
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
export function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(yes => { resolve = yes; }); return { resolve, promise }; }
export function windowResponse(request: Request, count = 251) {
  const url = new URL(request.url), direction = url.searchParams.get('direction'), seq = Number(url.searchParams.get('anchor_seq'));
  const all = Array.from({ length: count }, (_, i) => row(i + 1));
  const allowed = direction === 'before' ? all.filter(r => r.seq < seq) : direction === 'after' ? all.filter(r => r.seq > seq) : all;
  const messages = direction === 'oldest' || direction === 'after' ? allowed.slice(0, 50) : allowed.slice(-50);
  const first = messages[0], last = messages.at(-1);
  const hasOlder = !!first && all[0].seq < first.seq, hasNewer = !!last && all.at(-1)!.seq > last.seq;
  return envelope({ messages: messages.map(message => ({ ...message, replyToId: null, deletedAt: null })), readId: url.searchParams.get('read_id'), hasOlder, hasNewer,
    olderCursor: hasOlder ? { id: first.id, seq: first.seq } : null,
    newerCursor: hasNewer ? { id: last!.id, seq: last!.seq } : null });
}
export function fixture() {
  const client = { signIn: jest.fn(async () => identity), signOut: jest.fn(async () => true), getCookie: jest.fn(async () => 'test=cookie') };
  const discovery = jest.fn(async () => envelope(context));
  const history = jest.fn(async (r: Request) => windowResponse(r));
  const post = jest.fn(async (_r: Request) => envelope({}, 503));
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, client,
    request => baselineVisibility(request, new URL(request.url).pathname === '/v1/session/context' ? discovery() : request.method === 'POST' ? post(request) : history(request)), () => uuid(9));
  return { controller, client, history, discovery, post, login: () => controller.signIn('synthetic@example.test', 'test') };
}
