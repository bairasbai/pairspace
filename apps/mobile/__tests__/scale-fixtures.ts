import { createScaleController } from '../src/auth/scale';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { ScaleSlot } from '../src/auth/scale-state';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
export const slot: Extract<ScaleSlot, {
    state: 'active';
}> = { id: uuid(9), coupleId: uuid(2), authorId: uuid(1), membershipEpoch: 1, localDate: '2026-11-10', timezone: 'UTC', version: 1, createdAt: '2026-11-10T00:00:00.000Z', state: 'active', value: 0 };
export const removed: ScaleSlot = { id: slot.id, coupleId: slot.coupleId, authorId: slot.authorId, membershipEpoch: 1, localDate: slot.localDate, timezone: slot.timezone, version: 2, createdAt: slot.createdAt, state: 'removed' };
export const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
export const error = (error: string, status: number, current?: unknown) => new Response(JSON.stringify({ ok: false, error, ...(current ? { current } : {}) }), { status });
export const list = (slots: unknown[] = [], checkedAt = '2026-11-11T00:00:00.000Z', ownUsed = slots.filter(s => (s as ScaleSlot).authorId === context.userId).length) => envelope({ slots, checkedAt, capacityPerAuthor: 100, ownUsed });
export const ack = (value: unknown = slot, replay = false, commandId = uuid(3)) => envelope({ slot: value, replay, commandId });
export async function settle() { for (let i = 0; i < 45; i++)
    await Promise.resolve(); }
export function fixture() {
    let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
    const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => { }) };
    const discovery = jest.fn(async () => envelope(context)), operation = jest.fn(async (_r: Request) => ack()), command = jest.fn(() => uuid(3));
    const controller = createScaleController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host, r => r.url.endsWith('/context') ? discovery() : operation(r), command);
    controller.sync();
    return { controller, api: controller.actions, host, discovery, operation, command, set: (value: InvitationHostSnapshot | null) => { capture = value; },
        choose(value = '0') { controller.actions.setCreateField('expectedDate', slot.localDate); controller.actions.setCreateField('timezone', slot.timezone); controller.actions.setCreateField('value', value); },
        async load(slots: unknown[] = []) { operation.mockResolvedValueOnce(list(slots)); await controller.actions.load(); } };
}
