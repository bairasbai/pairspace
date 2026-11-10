import { createSessionController } from '../src/auth/controller';
import type { AuthIdentity } from '../src/auth/official-client';
import type { SessionContext } from '../src/auth/context';
import type { InvitationMetadata } from '../src/auth/invitations';
import type { SyntheticConfig } from '../src/auth/config';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const config: SyntheticConfig = { mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' };
export const identity: AuthIdentity = { userId: 'auth-user', sessionId: 'session' };
export const owner = { state: 'waiting_partner', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 } as const satisfies SessionContext;
export const recipient = { state: 'no_active_pair', sessionId: 'session', userId: uuid(1) } as const satisfies SessionContext;
export const ready = { ...owner, state: 'ready', membershipEpoch: 2 } as const satisfies SessionContext;
export const token = 'A'.repeat(43);
export const otherToken = 'B'.repeat(42) + 'A';
export const cookie = 'better-auth.session_token=synthetic-cookie';
export const metadata: InvitationMetadata = { id: uuid(3), commandId: uuid(4), status: 'pending',
  createdAt: '2026-11-10T00:00:00.000Z', expiresAt: '2026-11-10T00:10:00.000Z', revokedAt: null, consumedAt: null };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const errorResponse = (error = 'temporarily_unavailable', status = 503) => new Response(JSON.stringify({ ok: false, error }), { status });
export const issued = () => envelope({ state: 'issued', invitation: metadata, token }, 201);
export const previewed = () => envelope({ state: 'available', expiresAt: metadata.expiresAt });
export const accepted = () => envelope({ state: 'accepted', sessionId: identity.sessionId, userId: uuid(1), coupleId: uuid(2), membershipEpoch: 2, replayed: false });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function settle() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
export function setup(context: SessionContext = owner) {
  const client = {
    signIn: jest.fn<Promise<AuthIdentity | null>, [string, string]>().mockResolvedValue(identity),
    signOut: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    getCookie: jest.fn<Promise<string>, []>().mockResolvedValue(cookie),
  };
  const discovery = jest.fn<Promise<Response>, [Request]>(async () => envelope(context));
  const request = jest.fn<Promise<Response>, [Request]>(async input => {
    const path = new URL(input.url).pathname;
    if (path.endsWith('/chat/messages')) return envelope({ messages: [], nextBeforeSeq: null });
    if (path.endsWith('/preview')) return previewed();
    if (path.endsWith('/accept')) return accepted();
    if (input.method === 'GET') return envelope({ state: 'current', invitation: metadata });
    if (input.method === 'DELETE') return envelope({ state: 'revoked', revoked: true });
    return issued();
  });
  const commandId = jest.fn(() => uuid(4));
  const controller = createSessionController(config, client, input =>
    new URL(input.url).pathname === '/v1/session/context' ? discovery(input) : request(input), commandId);
  const login = () => controller.signIn('fixture@example.test', 'synthetic-password');
  const consent = async () => { controller.invitations.setToken(token); await controller.invitations.preview(); controller.invitations.setConsent(true); };
  return { controller, api: controller.invitations, client, discovery, request, commandId, login, consent };
}
