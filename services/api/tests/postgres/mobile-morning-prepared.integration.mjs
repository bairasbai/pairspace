import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latch } from './mobile-reply-fixture.mjs';
import { closeMobile } from './mobile-invitations-fixture.mjs';
import { morningsFixture, morningRequest as request, morningValue as value, morningCommand as command,
  setMorningPreference, futureDate, morningAccount } from './mobile-mornings-fixture.mjs';

test('prepared editor real HTTP/PG: noop, CAS edit, lost ACK exact retry and newer private drafts remain separate', async () => {
  const { f, pairA, connections } = await morningsFixture(); const accounts = [];
  let lose = false, hold = null; const bodies = [];
  try {
    await setMorningPreference(f, connections[1], pairA);
    const slot = value(await request(f, connections[0], pairA, '/slots', { method: 'POST',
      body: command({ preference_version: 1, local_date: futureDate(), offset: '+00:00' }) })).slot;
    const filled = value(await request(f, connections[0], pairA, `/slots/${slot.id}/body`, { method: 'PUT',
      body: command({ body: 'Synthetic prepared original\nSecond line' }) })).slot;
    const a = await morningAccount(f, 0, {
      beforeRequest: async (record, input) => {
        if (record.path.endsWith('/prepared') && record.method === 'PUT') bodies.push(await input.clone().json());
      },
      afterResponse: async (record, response) => {
        if (record.path.endsWith('/prepared') && record.method === 'PUT' && response.status === 200) {
          if (hold) { hold.arrive(); await hold.gate; }
          if (lose) { lose = false; throw Error('Synthetic lost prepared edit ACK'); }
        }
      },
    }); accounts.push(a);
    const editor = a.controller.morningPrepared, morning = a.controller.mornings;
    await morning.list(); morning.selectSlot(slot.id); morning.setDraft('Unrelated fill composer remains private');
    await editor.begin(filled);
    assert.equal(editor.getSnapshot().status, 'ready'); assert.equal(editor.getSnapshot().version, 1);
    editor.setDraft('Synthetic prepared original\r\nSecond line'); await editor.save();
    assert.equal(editor.getSnapshot().version, 1, 'normalized no-op does not invent version');
    editor.setDraft('Synthetic edited text'); await editor.save(); assert.equal(editor.getSnapshot().version, 2);
    editor.setDraft('Synthetic pending replacement'); lose = true; await editor.save();
    assert.equal(editor.getSnapshot().status, 'unknown');
    editor.setDraft('Newer private draft'); editor.cancel(); await editor.save(); await editor.reload();
    assert.equal(editor.getSnapshot().status, 'unknown');
    await editor.retry(); assert.deepEqual(bodies.at(-1), bodies.at(-2), 'unknown retry uses exact immutable body/version/ID');
    assert.equal(editor.getSnapshot().status, 'saved'); assert.equal(editor.getSnapshot().version, 3);
    assert.equal(editor.getSnapshot().draft, 'Newer private draft');
    assert.equal(morning.getSnapshot().draft, 'Unrelated fill composer remains private');
    const recipient = value(await request(f, connections[1], pairA, `/slots/${slot.id}`));
    assert.equal(recipient.slot.state, 'sealed'); assert.equal(Object.hasOwn(recipient, 'body'), false);
    assert.equal(Object.hasOwn(recipient.slot, 'prepared'), false);
    hold = latch();
    const saving = editor.save(); await hold.reached;
    editor.setDraft('Typed while successful ACK held'); hold.release(); await saving; hold = null;
    assert.equal(editor.getSnapshot().version, 4); assert.equal(editor.getSnapshot().draft, 'Typed while successful ACK held');
    const stored = (await f.domainPool.query('SELECT body,version FROM morning_content WHERE slot_id=$1', [slot.id])).rows[0];
    assert.equal(stored.body, 'Newer private draft'); assert.equal(stored.version, 4);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_prepared_receipts WHERE slot_id=$1', [slot.id])).rows[0].n, 4);
    await a.controller.signOut(); assert.equal(editor.getSnapshot().draft, ''); assert.equal(editor.getSnapshot().available, false);
  } finally { if (hold) hold.release(); await closeMobile(f, accounts); }
});
