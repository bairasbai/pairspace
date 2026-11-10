import { createBlindController } from '../src/auth/blind';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const round = { id: uuid(9), coupleId: uuid(2), membershipEpoch: 1,
  questionId: 'small-joy', catalogVersion: 1, ownAnswer: null as string | null, partnerAnswer: null as string | null, revealed: false };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status });
export const ack = (item: unknown = round, replay = false, commandId = uuid(3)) => envelope({ round: item, replay, commandId });
export async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context));
  const operation = jest.fn(async (_r: Request) => ack());
  const command = jest.fn(() => uuid(3));
  const controller = createBlindController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setDraft('Small joy');
  return { controller, api: controller.actions, host, discovery, operation, command, set: (v: InvitationHostSnapshot | null) => { capture = v; } };
}
