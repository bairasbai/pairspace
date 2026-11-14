import { createMorningDraftController } from '../src/auth/morning-draft';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import { id, scope, slot, envelope } from './mornings.fixture';
export const draftSlot = () => ({ ...slot(), prepared: false });
export const now = '2030-01-01T00:00:00.000Z';
export function draftFixture(limit = 500) {
  let captured: InvitationHostSnapshot | null = { generation: 1, identity: { userId: 'provider', sessionId: 'session' }, context: scope };
  const host = { capture: () => captured, getCookie: jest.fn(async () => 'session=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  let body = 'original', version = 1, sequence = 100;
  const read = jest.fn(async (request: Request) => envelope({ readId: new URL(request.url).searchParams.get('read_id'),
    state: 'live', serverNow: now, slot: draftSlot(), body, version }));
  const write = jest.fn(async (request: Request) => {
    const input = await request.clone().json();
    if (input.body !== body) version++;
    body = input.body;
    return envelope({ commandId: input.command_id, replay: false, state: 'live', serverNow: now, slot: draftSlot(), body, version });
  });
  const request = jest.fn(async (input: Request) => input.url.endsWith('/context') ? envelope(captured?.context)
    : input.method === 'GET' ? read(input) : write(input));
  const identity = jest.fn(() => id(sequence++));
  const feature = createMorningDraftController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, host, request, identity, limit);
  feature.sync();
  return { feature, actions: feature.actions, host, request, read, write, identity,
    setCanonical(text: string, v: number) { body = text; version = v; },
    setCapture(next: InvitationHostSnapshot | null, sync = true) { captured = next; if (sync) feature.sync(); } };
}
export const failure = (error: string, request: Request, status = 409) => new Response(JSON.stringify({ ok: false, error,
  ...(request.method === 'GET' ? { readId: new URL(request.url).searchParams.get('read_id') } : {}) }), { status });
