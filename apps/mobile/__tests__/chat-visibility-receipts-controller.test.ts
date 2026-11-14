/// <reference types="node" />
import { createHash } from 'node:crypto';
import { visibilityFixture, wire, row } from './chat-visibility.fixture';
import { deferred, settle } from './chat-window.fixture';

for (const reply of [false, true]) {
  test(`${reply ? 'reply' : 'plain'} committed hidden receipt resolves without republishing text or erasing newer draft`, async () => {
    const f = visibilityFixture(); await f.login();
    if (reply) f.controller.setReplyTarget(f.rows[101].id);
    let saved: (typeof f.rows)[number] | null = null;
    const bodies: unknown[] = [];
    f.request.mockImplementation(async r => {
      if (r.method !== 'POST') return f.response(r);
      const body = await r.clone().json(); bodies.push(body);
      if (!saved) {
        saved = { ...row(300), clientId: body.client_message_id, body: body.body, replyToId: body.reply_to_id ?? null, deletedAt: null };
        throw Error('lost ACK');
      }
      const { body: _body, ...hiddenMessage } = saved;
      return wire({ replay: true, hiddenMessage }, f.revision());
    });
    f.controller.setDraft('original submitted text'); await f.controller.send();
    expect(f.controller.getSnapshot().outgoing?.status).toBe('retry');
    f.hide(row(300).id);
    f.controller.setDraft('new private text');
    await f.controller.visibility.loadLatest();
    const observed: string[] = [];
    const unsubscribe = f.controller.subscribe(() => observed.push(JSON.stringify(f.controller.getSnapshot())));
    await f.controller.send(); unsubscribe();
    expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]);
    expect(f.controller.getSnapshot().hiddenAcknowledged).toBe(true);
    expect(f.controller.getSnapshot().outgoing).toBeUndefined();
    expect(f.controller.getSnapshot().draft).toBe('new private text');
    expect(observed.join('')).not.toContain('original submitted text');
  });
}

test('hidden deleted committed receipt installs terminal barrier before later restored stale live page', async () => {
  const f = visibilityFixture(); await f.login();
  let saved: (typeof f.rows)[number] | null = null;
  f.request.mockImplementation(async r => {
    if (r.method !== 'POST') return f.response(r);
    const body = await r.clone().json();
    if (!saved) { saved = { ...row(300), clientId: body.client_message_id, body: body.body, replyToId: null, deletedAt: null }; throw Error('lost'); }
    const { body: _body, ...metadata } = saved;
    return wire({ replay: true, hiddenMessage: { ...metadata, version: 2, deletedAt: '2026-11-12T00:00:00.000Z' } }, f.revision());
  });
  f.controller.setDraft('deleted original'); await f.controller.send();
  f.hide(row(300).id); f.controller.setDraft('new private draft'); await f.controller.send();
  expect(f.controller.getSnapshot().outgoing).toBeUndefined();
  f.rows.push(saved!);
  await f.controller.visibility.loadLatest();
  f.controller.visibility.beginRestore(row(300).id);
  await f.controller.visibility.confirm(f.controller.visibility.getSnapshot().confirmation!.token);
  await f.controller.loadLatest();
  expect(JSON.stringify(f.controller.getSnapshot().messages)).not.toContain('deleted original');
  expect(f.controller.getSnapshot().draft).toBe('new private draft');
});

test('body response held inside digest cannot commit after a newer visibility fence', async () => {
  const digestWait = deferred(); let hashing = false;
  const f = visibilityFixture(102, async body => {
    if (body === 'edited pending digest') { hashing = true; await digestWait.promise; }
    return createHash('sha256').update(body).digest('hex');
  });
  await f.login();
  await f.controller.visibility.beginHide(f.rows[101].id);
  const confirmation = f.controller.visibility.getSnapshot().confirmation!.token;
  f.rows[101].body = 'edited pending digest'; f.rows[101].version = 2;
  const load = f.controller.loadLatest();
  for (let n = 0; n < 10 && !hashing; n++) await settle();
  expect(hashing).toBe(true);
  await f.controller.visibility.confirm(confirmation);
  digestWait.resolve(wire({}, 0)); await load;
  expect(f.controller.getSnapshot().messages).toHaveLength(0);
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('edited pending digest');
});
