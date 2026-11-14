import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeMobile } from './mobile-invitations-fixture.mjs';
import { morningsFixture, morningRequest as request, morningValue as value, morningCommand as command,
  setMorningPreference, futureDate, morningAccount } from './mobile-mornings-fixture.mjs';

test('private draft removal real HTTP: confirmed terminal delete, lost ACK retry, private input and ready letter isolation', async () => {
  const { f, pairA, connections } = await morningsFixture(); const accounts = [], deletes = [];
  let lose = false;
  try {
    await setMorningPreference(f, connections[1], pairA);
    const slot = value(await request(f, connections[0], pairA, '/slots', { method: 'POST',
      body: command({ preference_version: 1, local_date: futureDate(), offset: '+00:00' }) })).slot;
    const saved = command({ expected_version: 0, body: 'Private text to remove' });
    value(await request(f, connections[0], pairA, `/slots/${slot.id}/draft`, { method: 'PUT', body: saved }));
    const fill = command({ body: 'Ready letter must remain' });
    const filled = value(await request(f, connections[0], pairA, `/slots/${slot.id}/body`, { method: 'PUT', body: fill })).slot;
    const recipient = value(await request(f, connections[1], pairA, `/slots/${slot.id}`)).slot;
    const a = await morningAccount(f, 0, {
      beforeRequest: async (record, input) => {
        if (record.path.endsWith('/draft-v2') && record.method === 'DELETE') deletes.push(await input.clone().json());
      },
      afterResponse: async (record, response) => {
        if (record.path.endsWith('/draft-v2') && record.method === 'DELETE' && response.status === 200 && lose) {
          lose = false; throw Error('Synthetic lost committed delete ACK');
        }
      },
    }); accounts.push(a);
    const editor = a.controller.morningDraft;
    await editor.begin(filled); assert.equal(editor.getSnapshot().draft, saved.body);
    editor.beginDelete(); const cancelled = editor.getSnapshot().confirmation.token;
    editor.cancelDelete(); await editor.confirmDelete(cancelled); assert.equal(deletes.length, 0);
    editor.beginDelete(); const old = editor.getSnapshot().confirmation.token;
    editor.setDraft('Changed before confirmation'); await editor.confirmDelete(old); assert.equal(deletes.length, 0);
    editor.beginDelete(); lose = true; await editor.confirmDelete(editor.getSnapshot().confirmation.token);
    assert.equal(editor.getSnapshot().status, 'unknown'); assert.equal(deletes.length, 1);
    editor.setDraft('Unsent private input after delete'); editor.cancel(); await editor.save(); await editor.reload();
    await editor.retry(); assert.deepEqual(deletes[1], deletes[0]);
    assert.equal(editor.getSnapshot().status, 'deleted'); assert.equal(editor.getSnapshot().draft, 'Unsent private input after delete');
    assert.equal(editor.getSnapshot().version, 2);
    assert.equal(value(await request(f, connections[0], pairA, `/slots/${slot.id}/prepared`)).body, fill.body);
    assert.deepEqual(value(await request(f, connections[1], pairA, `/slots/${slot.id}`)).slot, recipient);
    const legacy = await request(f, connections[0], pairA, `/slots/${slot.id}/draft`);
    assert.equal(legacy.status, 409); assert.equal(legacy.payload.error, 'draft_deleted'); assert.equal(Object.hasOwn(legacy.payload, 'value'), false);
    const replay = value(await request(f, connections[0], pairA, `/slots/${slot.id}/draft-v2`, { method: 'PUT', body: saved }));
    assert.equal(replay.state, 'deleted'); assert.equal(replay.body, null); assert.equal(replay.replay, true);
    editor.cancel(); await editor.begin(filled); assert.equal(editor.getSnapshot().status, 'deleted'); assert.equal(editor.getSnapshot().draft, '');
    await a.controller.signOut(); assert.equal(editor.getSnapshot().available, false);
  } finally { await closeMobile(f, accounts); }
});
