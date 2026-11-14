/// <reference types="node" />
import { createHash } from 'node:crypto';
import { createSessionController } from '../src/auth/controller';
import { context, identity, row, uuid } from './chat-window.fixture';
export { context, row, uuid };
export const wire = (value: unknown, revision: number, status = 200) => new Response(JSON.stringify(status === 200 ? { ok: true, value } : value), { status, headers: { 'X-Chat-Visibility-Revision': String(revision) } });
export function visibilityFixture(count = 102, digest = async (body: string) => createHash('sha256').update(body).digest('hex')) {
  let revision = 0, command = 9000;
  const rows = Array.from({ length: count }, (_, i) => ({ ...row(i + 1), replyToId: null as string | null, deletedAt: null as string | null, body: `Synthetic ${i + 1}` as string | null }));
  const states = new Map<string, { hidden: boolean; version: number }>();
  const receipts = new Map<string, string>();
  const client = { signIn: jest.fn(async () => identity), signOut: jest.fn(async () => true), getCookie: jest.fn(async () => 'test=cookie') };
  const response = async (request: Request): Promise<Response> => {
    const u = new URL(request.url), readId = u.searchParams.get('read_id');
    if (u.pathname.endsWith('/context')) return wire(context, revision);
    if (request.method === 'PUT') {
      const body = await request.clone().json();
      const id = u.pathname.split('/').at(-2)!;
      const old = states.get(id) ?? { hidden: false, version: 0 };
      const replay = receipts.has(body.command_id);
      if (!replay && old.version !== body.expected_visibility_version) return wire({ ok: false, error: 'version_conflict' }, revision, 409);
      if (!replay && old.hidden !== body.hidden) { states.set(id, { hidden: body.hidden, version: old.version + 1 }); revision++; }
      receipts.set(body.command_id, id);
      return wire({ commandId: body.command_id, replay, visibility: { messageId: id, ...(states.get(id) ?? old) } }, revision);
    }
    if (u.pathname.endsWith('/visibility')) {
      const id = u.pathname.split('/').at(-2)!;
      return wire({ visibility: { messageId: id, ...(states.get(id) ?? { hidden: false, version: 0 }) }, readId }, revision);
    }
    if (u.pathname.endsWith('/message-detail')) {
      const message = rows.find(r => r.id === u.searchParams.get('message_id'));
      if (!message || states.get(message.id)?.hidden) return wire({ ok: false, error: 'message_hidden', readId }, revision, 409);
      return wire({ message, readId }, revision);
    }
    const hidden = u.pathname.endsWith('/hidden-window');
    const all = rows.filter(r => !!states.get(r.id)?.hidden === hidden);
    const direction = u.searchParams.get('direction'), anchor = Number(u.searchParams.get('anchor_seq'));
    const candidates = direction === 'before' ? all.filter(r => r.seq < anchor) : direction === 'after' ? all.filter(r => r.seq > anchor) : all;
    const page = direction === 'oldest' || direction === 'after' ? candidates.slice(0, 50) : candidates.slice(-50);
    const hasOlder = !!page.length && page[0].seq > all[0].seq;
    const hasNewer = !!page.length && page.at(-1)!.seq < all.at(-1)!.seq;
    const messages = page.map(r => {
      if (!hidden) return r;
      const { body: _body, ...metadata } = r;
      return { ...metadata, visibilityVersion: states.get(r.id)!.version };
    });
    return wire({ messages, readId, hasOlder, hasNewer,
      olderCursor: hasOlder ? { id: page[0].id, seq: page[0].seq } : null,
      newerCursor: hasNewer ? { id: page.at(-1)!.id, seq: page.at(-1)!.seq } : null }, revision);
  };
  const request = jest.fn(response);
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, client, request,
    () => uuid(command++), digest);
  return { controller, client, request, response, rows, states, revision: () => revision,
    hide(id: string) { const old = states.get(id); states.set(id, { hidden: true, version: (old?.version ?? 0) + 1 }); revision++; },
    login: () => controller.signIn('a@example.test', 'test') };
}
