import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latch } from './mobile-reply-fixture.mjs';
import { closeMobile } from './mobile-invitations-fixture.mjs';
import { morningsFixture, morningRequest as request, morningValue as value, morningCommand as command,
  setMorningPreference, futureDate, morningAccount } from './mobile-mornings-fixture.mjs';

test('private draft real HTTP/PG: explicit save, CAS, immutable lost ACK retry, newer input and filled body isolation', async () => {
  const { f, pairA, connections } = await morningsFixture(); const accounts = [];
  let lose = false, hold = null; const bodies = [];
  try {
    await setMorningPreference(f, connections[1], pairA);
    const slot = value(await request(f, connections[0], pairA, '/slots', { method: 'POST',
      body: command({ preference_version: 1, local_date: futureDate(), offset: '+00:00' }) })).slot;
    const sealed = value(await request(f, connections[1], pairA, `/slots/${slot.id}`)).slot;
    const a = await morningAccount(f, 0, {
      beforeRequest: async (record, input) => {
        if (record.path.endsWith('/draft-v2') && record.method === 'PUT') bodies.push(await input.clone().json());
      },
      afterResponse: async (record, response) => {
        if (record.path.endsWith('/draft-v2') && record.method === 'PUT' && response.status === 200) {
          if (hold) { hold.arrive(); await hold.gate; }
          if (lose) { lose = false; throw Error('Synthetic lost private draft ACK'); }
        }
      },
    }); accounts.push(a);
    const b = await morningAccount(f, 0); accounts.push(b);
    const editor = a.controller.morningDraft, other = b.controller.morningDraft, morning = a.controller.mornings;
    await morning.list(); morning.selectSlot(slot.id); morning.setDraft('Unrelated local fill composer');
    await editor.begin(slot); await other.begin(slot);
    assert.equal(editor.getSnapshot().version, 0); assert.equal(editor.getSnapshot().draft, '');
    editor.setDraft('Private saved text\nSecond line'); await editor.save();
    assert.equal(editor.getSnapshot().version, 1);
    editor.setDraft('Private saved text\r\nSecond line'); await editor.save();
    assert.equal(editor.getSnapshot().version, 1, 'normalized no-op');
    other.setDraft('Competing private input'); await other.save();
    assert.equal(other.getSnapshot().status, 'conflict'); assert.equal(other.getSnapshot().draft, 'Competing private input');
    await other.reload(); assert.equal(other.getSnapshot().draft, 'Competing private input');
    await other.save(); assert.equal(other.getSnapshot().version, 2);
    await editor.reload(); editor.setDraft('Committed before lost ACK'); lose = true; await editor.save();
    assert.equal(editor.getSnapshot().status, 'unknown');
    editor.setDraft('Newer unpublished input'); editor.cancel(); await editor.save(); await editor.reload();
    assert.equal(editor.getSnapshot().status, 'unknown');
    await editor.retry(); assert.deepEqual(bodies.at(-1), bodies.at(-2));
    assert.equal(editor.getSnapshot().status, 'saved'); assert.equal(editor.getSnapshot().version, 3);
    assert.equal(editor.getSnapshot().draft, 'Newer unpublished input');
    assert.equal(morning.getSnapshot().draft, 'Unrelated local fill composer');
    assert.deepEqual(value(await request(f, connections[1], pairA, `/slots/${slot.id}`)).slot, sealed);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_content WHERE slot_id=$1', [slot.id])).rows[0].n, 0);
    const fill = command({ body: 'Separately confirmed ready letter' });
    value(await request(f, connections[0], pairA, `/slots/${slot.id}/body`, { method: 'PUT', body: fill }));
    hold = latch(); const saving = editor.save(); await hold.reached;
    editor.setDraft('Typed while saved draft ACK held'); hold.release(); await saving; hold = null;
    assert.equal(editor.getSnapshot().version, 4); assert.equal(editor.getSnapshot().draft, 'Typed while saved draft ACK held');
    assert.equal(value(await request(f, connections[0], pairA, `/slots/${slot.id}/prepared`)).body, fill.body);
    await a.controller.signOut(); assert.equal(editor.getSnapshot().draft, ''); assert.equal(editor.getSnapshot().available, false);
  } finally { if (hold) hold.release(); await closeMobile(f, accounts); }
});
