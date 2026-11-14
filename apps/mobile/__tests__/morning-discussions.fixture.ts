import { createHash } from 'node:crypto';
import type { BodyDigest } from '../src/chat/edit-knowledge';
import { createMorningDiscussionsController } from '../src/auth/morning-discussions';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import { id, scope, slot, envelope } from './mornings.fixture';
export { id, scope, envelope, deferred } from './mornings.fixture';
export const available = (n = 10, recipient = false) => ({ ...slot(n, recipient), state: 'available' as const,
  ...(recipient ? { openedAt: '2030-01-02T09:00:00.000Z' } : { prepared: true }) });
export const message = (seq = 1, slotId = id(10)) => ({ id: id(1000 + seq), slotId, coupleId: id(3), membershipEpoch: 1,
  authorId: id(1), clientId: id(2000 + seq), seq, body: `Answer ${seq}\nSecond line`, createdAt: '2030-01-02T09:00:00.000Z', version: 1, editedAt: null as string | null, deletedAt: null as string | null });
export const sha: BodyDigest = async body => createHash('sha256').update(body).digest('hex');
export function fixture(digest: BodyDigest = sha) {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { userId: 'provider', sessionId: 'session' }, context: scope };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'session=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const read = jest.fn(async (request: Request) => {
    const url = new URL(request.url), slotId = url.pathname.split('/').at(-2)!;
    const direction = url.searchParams.get('direction'), anchor = Number(url.searchParams.get('anchor_seq'));
    const rows = Array.from({ length: 71 }, (_, index) => message(index + 1, slotId));
    const filtered = direction === 'before' ? rows.filter(m => m.seq < anchor) : direction === 'after' ? rows.filter(m => m.seq > anchor) : rows;
    const messages = direction === 'last' || direction === 'before' ? filtered.slice(-30) : filtered.slice(0, 30);
    const hasPrevious = !!messages.length && messages[0].seq > 1, hasNext = !!messages.length && messages.at(-1)!.seq < 71;
    return envelope({ readId: url.searchParams.get('read_id'), slotId, messages, hasPrevious, hasNext,
      previousCursor: hasPrevious ? { id: messages[0].id, seq: messages[0].seq } : null,
      nextCursor: hasNext ? { id: messages.at(-1)!.id, seq: messages.at(-1)!.seq } : null });
  });
  const write = jest.fn(async (request: Request) => {
    const input = await request.clone().json();
    return envelope({ commandId: input.command_id, replay: false, message: { ...message(72, new URL(request.url).pathname.split('/').at(-2)),
      clientId: input.command_id, body: input.body } });
  });
  const request = jest.fn(async (input: Request) => input.url.endsWith('/context') ? envelope(capture?.context)
    : input.method === 'GET' ? read(input) : write(input));
  let serial = 3000;
  const feature = createMorningDiscussionsController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, host, request, () => id(serial++), digest);
  feature.sync();
  return { feature, actions: feature.actions, host, request, read, write,
    setCapture(next: InvitationHostSnapshot | null) { capture = next; feature.sync(); } };
}
