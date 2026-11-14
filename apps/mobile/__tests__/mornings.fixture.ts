import { createMorningsController } from '../src/auth/mornings';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import type { MorningSlot } from '../src/auth/morning-model';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const scope = { state: 'ready' as const, sessionId: 'session', userId: id(1), coupleId: id(3), membershipEpoch: 1 };
export const prefs = [{ userId: id(1), timezone: 'UTC', localTime: '09:00', version: 1 }, { userId: id(2), timezone: 'UTC', localTime: '09:00', version: 1 }];
export const slot = (n = 10, recipient = false): MorningSlot => ({ id: id(n), coupleId: id(3), membershipEpoch: 1,
    senderId: recipient ? id(2) : id(1), recipientId: recipient ? id(1) : id(2), localDate: '2030-01-02', localTime: '09:00',
    timezone: 'UTC', offset: '+00:00', releaseAt: '2030-01-02T09:00:00.000Z', preferenceVersion: 1, createdAt: '2030-01-01T00:00:00.000Z',
    state: 'sealed', ...(recipient ? { openedAt: null } : { prepared: false }) });
export const envelope = (value: unknown) => new Response(JSON.stringify({ ok: true, value }));
export const deferred = () => { let resolve!: (value: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { resolve, promise }; };
export function fixture() {
    let captured: InvitationHostSnapshot | null = { generation: 1, identity: { userId: 'provider', sessionId: 'session' }, context: scope };
    const host = { capture: () => captured, getCookie: jest.fn(async () => 'session=cookie'), block: jest.fn(), refresh: jest.fn(async () => { }) };
    const read = jest.fn(async (request: Request) => {
        const url = new URL(request.url);
        return envelope({ readId: url.searchParams.get('read_id'), serverNow: '2030-01-01T00:00:00.000Z', preferences: prefs,
            slots: [slot(11), slot(10)], hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null, lastAvailableId: null });
    });
    const write = jest.fn(async (request: Request) => {
        const input = await request.clone().json(), pathname = new URL(request.url).pathname;
        if (pathname.endsWith('/preference'))
            return envelope({ commandId: input.command_id, replay: false,
                preference: { userId: id(1), timezone: input.timezone, localTime: input.local_time, version: input.expected_version + 1 } });
        if (pathname.endsWith('/body'))
            return envelope({ commandId: input.command_id, replay: false,
                slot: { ...slot(Number(pathname.split('/').at(-2)!.slice(-12))), prepared: true } });
        return envelope({ commandId: input.command_id, replay: false, slot: { ...slot(20), localDate: input.local_date,
                releaseAt: `${input.local_date}T09:00:00.000Z`, offset: input.offset, preferenceVersion: input.preference_version } });
    });
    const request = jest.fn(async (input: Request) => input.url.endsWith('/context') ? envelope(captured?.context)
        : input.method === 'GET' ? read(input) : write(input));
    let sequence = 100;
    const feature = createMorningsController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, host, request, () => id(sequence++));
    feature.sync();
    return { actions: feature.actions, feature, host, request, read, write,
        setCapture(next: InvitationHostSnapshot | null) { captured = next; feature.sync(); } };
}
