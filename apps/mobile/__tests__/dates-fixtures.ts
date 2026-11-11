import { createDatesController } from '../src/auth/dates';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const date = { version: 1, id: uuid(9), creatorId: uuid(1), coupleId: uuid(2), membershipEpoch: 1,
  recurrence: 'once' as const, leapDayPolicy: null, asOfLocalDate: '2026-11-10', nextOccurrence: '2028-02-29',
  title: 'Shared date', localDate: '2028-02-29', timezone: 'Asia/Tokyo', createdAt: '2026-11-10T00:00:00.000Z' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (code: string, status: number) => new Response(JSON.stringify({ ok: false, error: code }), { status });
export const ack = (item: unknown = date, replay = false, commandId = uuid(3)) => envelope({ date: item, replay, commandId });
export async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
export function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context));
  const operation = jest.fn(async (_r: Request) => ack());
  const command = jest.fn(() => uuid(3));
  const controller = createDatesController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setDraft(date.title); controller.actions.setLocalDate(date.localDate); controller.actions.setTimezone(date.timezone);
  return { controller, api: controller.actions, host, discovery, operation, command, set: (v: InvitationHostSnapshot | null) => { capture = v; } };
}
