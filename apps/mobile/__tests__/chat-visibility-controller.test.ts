import { visibilityFixture, wire } from './chat-visibility.fixture';
import { deferred, settle } from './chat-window.fixture';

test('explicit personal hide and restore preserve new draft and require explicit history refresh', async () => {
  const f = visibilityFixture(); await f.login();
  const id = f.rows[101].id;
  f.controller.setDraft('private newer draft');
  await f.controller.visibility.beginHide(id);
  const token = f.controller.visibility.getSnapshot().confirmation!.token;
  expect(f.request.mock.calls.filter(([r]) => r.method === 'PUT')).toHaveLength(0);
  await f.controller.visibility.confirm(token);
  expect(f.controller.visibility.getSnapshot().status).toBe('saved');
  expect(f.controller.getSnapshot().messages).toHaveLength(0);
  expect(f.controller.getSnapshot().draft).toBe('private newer draft');
  await f.controller.loadLatest();
  expect(f.controller.getSnapshot().messages.some(m => m.id === id)).toBe(false);
  await f.controller.visibility.loadLatest();
  expect(f.controller.visibility.getSnapshot().history!.messages[0]).not.toHaveProperty('body');
  f.controller.visibility.beginRestore(id);
  await f.controller.visibility.confirm(f.controller.visibility.getSnapshot().confirmation!.token);
  await f.controller.loadLatest();
  expect(f.controller.getSnapshot().messages.some(m => m.id === id)).toBe(true);
});

test('cancel and obsolete confirmation cannot write; target B requires its own token', async () => {
  const f = visibilityFixture(); await f.login();
  await f.controller.visibility.beginHide(f.rows[100].id);
  const old = f.controller.visibility.getSnapshot().confirmation!.token;
  f.controller.visibility.cancel(); await f.controller.visibility.confirm(old);
  await f.controller.visibility.beginHide(f.rows[101].id);
  await f.controller.visibility.confirm(old);
  expect(f.request.mock.calls.filter(([r]) => r.method === 'PUT')).toHaveLength(0);
  await f.controller.visibility.confirm(f.controller.visibility.getSnapshot().confirmation!.token);
  expect(f.states.get(f.rows[100].id)).toBeUndefined();
});

test('lost hide ACK retries immutable command; newer draft survives', async () => {
  const f = visibilityFixture(); await f.login();
  await f.controller.visibility.beginHide(f.rows[101].id);
  let lost = false;
  f.request.mockImplementation(async r => { const response = await f.response(r); if (r.method === 'PUT' && !lost) { lost = true; throw Error('lost ACK'); } return response; });
  await f.controller.visibility.confirm(f.controller.visibility.getSnapshot().confirmation!.token);
  expect(f.controller.visibility.getSnapshot().status).toBe('unknown');
  f.controller.setDraft('new body');
  await f.controller.visibility.retry();
  expect(f.controller.visibility.getSnapshot().status).toBe('saved');
  expect(f.controller.visibility.getSnapshot().pendingId).toBeUndefined();
  const puts = f.request.mock.calls.map(([r]) => r).filter(r => r.method === 'PUT');
  expect(await puts[0].clone().json()).toEqual(await puts[1].clone().json());
  expect(f.controller.getSnapshot().draft).toBe('new body');
});

test('hidden history navigates bounded windows without plaintext', async () => {
  const f = visibilityFixture(162); f.rows.forEach(r => f.hide(r.id)); await f.login();
  await f.controller.visibility.loadLatest();
  expect(f.controller.visibility.getSnapshot().history!.messages).toHaveLength(50);
  await f.controller.visibility.loadOldest();
  expect(f.controller.visibility.getSnapshot().history!.messages[0].id).toBe(f.rows[0].id);
  await f.controller.visibility.loadNewer();
  expect(f.controller.visibility.getSnapshot().history!.messages[0].id).toBe(f.rows[50].id);
  await f.controller.visibility.loadOlder();
  expect(f.controller.visibility.getSnapshot().history!.messages[0].id).toBe(f.rows[0].id);
  expect(JSON.stringify(f.controller.visibility.getSnapshot())).not.toContain('Synthetic');
});

test('higher revision learned on another device clears old body and rejects delayed older response', async () => {
  const f = visibilityFixture(); await f.login();
  const held = deferred();
  let heldOnce = false;
  f.request.mockImplementation(async r => { const response = await f.response(r); if (r.url.includes('/reply-window?') && !heldOnce) { heldOnce = true; await held.promise; } return response; });
  const old = f.controller.loadLatest(); await settle();
  f.hide(f.rows[101].id);
  await f.controller.visibility.loadLatest();
  held.resolve(wire({}, 0)); await old;
  expect(f.controller.getSnapshot().messages).toHaveLength(0);
  await f.controller.loadLatest();
  expect(f.controller.getSnapshot().messages.some(m => m.id === f.rows[101].id)).toBe(false);
});

test('late personal visibility mutation cannot publish after sign-out', async () => {
  const f = visibilityFixture(); await f.login();
  await f.controller.visibility.beginHide(f.rows[101].id);
  const held = deferred(); f.request.mockImplementation(async r => { const response = await f.response(r); if (r.method === 'PUT') await held.promise; return response; });
  const mutation = f.controller.visibility.confirm(f.controller.visibility.getSnapshot().confirmation!.token);
  await settle(); await f.controller.signOut(); held.resolve(wire({}, 0)); await mutation;
  expect(f.controller.visibility.getSnapshot()).toEqual({ status: 'idle' });
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
});

test('observed hidden deleted metadata remains terminal after restore and stale live page', async () => {
  const f = visibilityFixture(); await f.login();
  const original = { ...f.rows[101] };
  f.rows[101].body = null; f.rows[101].deletedAt = '2026-11-12T00:00:00.000Z'; f.rows[101].version = 2;
  f.hide(original.id);
  await f.controller.visibility.loadLatest();
  f.controller.visibility.beginRestore(original.id);
  await f.controller.visibility.confirm(f.controller.visibility.getSnapshot().confirmation!.token);
  f.rows[101] = original;
  await f.controller.loadLatest();
  expect(JSON.stringify(f.controller.getSnapshot().messages)).not.toContain('Synthetic 102');
});

test('missing revision rejects an opted-in body response rather than assuming revision zero', async () => {
  const f = visibilityFixture(); await f.login();
  f.request.mockImplementation(async r => {
    const response = await f.response(r);
    if (!r.url.includes('/reply-window?')) return response;
    const headers = new Headers(response.headers); headers.delete('X-Chat-Visibility-Revision');
    return new Response(await response.text(), { status: response.status, headers });
  });
  const before = f.controller.getSnapshot().messages;
  await f.controller.loadLatest();
  expect(f.controller.getSnapshot().history?.status).toBe('error');
  expect(f.controller.getSnapshot().messages).toEqual(before);
});

for (const revision of [null, '0', '99']) {
  test(`current scoped membership denial blocks before visibility filtering (${revision})`, async () => {
    const f = visibilityFixture(); await f.login();
    f.request.mockImplementation(async r => {
      if (!r.url.includes('/reply-window?')) return f.response(r);
      return new Response(JSON.stringify({ ok: false, error: 'stale_membership', readId: new URL(r.url).searchParams.get('read_id') }), {
        status: 409, headers: revision === null ? {} : { 'X-Chat-Visibility-Revision': revision },
      });
    });
    await f.controller.loadLatest();
    expect(f.controller.getSnapshot().phase).toBe('blocked');
    expect(f.controller.getSnapshot().messages).toHaveLength(0);
  });
}
