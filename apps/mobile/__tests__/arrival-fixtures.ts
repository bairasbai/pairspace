import { createArrivalController } from '../src/auth/arrival';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const date = { version: 1, id: uuid(9), creatorId: uuid(1), coupleId: uuid(2), membershipEpoch: 1,
  localDate: '2028-02-29', localTime: '09:00', offset: '+09:00', arrivesAt: '2028-02-29T00:00:00.000Z',
  label: 'Shared plan', timezone: 'Asia/Tokyo', createdAt: '2026-11-10T00:00:00.000Z' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status });
export const ack = (item: unknown = date, replay = false, commandId = uuid(3)) => envelope({ plan: item, replay, commandId, asOf: '2028-02-29T00:00:00.000Z' });
export async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context));
  const operation = jest.fn(async (_r: Request) => ack());
  const command = jest.fn(() => uuid(3));
  const controller = createArrivalController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync();
  for (const key of ['label','localDate','localTime','timezone','offset'] as const) controller.actions.setField(key,date[key]);
  return { controller, api: controller.actions, host, discovery, operation, command, set: (v: InvitationHostSnapshot | null) => { capture = v; } };
}
