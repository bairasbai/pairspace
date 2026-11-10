import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lettersFixture } from './letters-fixture.mjs';
import { mobile, closeMobile } from './mobile-invitations-fixture.mjs';

test('real PostgreSQL mobile letters: RAM privacy, unknown ACK immutable retry, later draft retained, partner list/open and scope reset', async () => {
  const { f, pairA, usersA } = await lettersFixture(); const accounts = [];
  try {
    let loseAck = true; const commands = [];
    accounts.push(await mobile(f, 0, { email: 'letters-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.endsWith('/letters') && request.method === 'POST') {
          commands.push(await request.clone().json());
          assert.equal(request.headers.get('idempotency-key'), commands.at(-1).client_letter_id);
        }
      },
      afterResponse: async (record, response) => {
        if (record.path.endsWith('/letters') && record.method === 'POST' && loseAck) {
          assert.equal(response.status, 201); loseAck = false; throw new Error('Synthetic lost committed ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'letters-1@example.test', signup: false }));
    accounts.push(await mobile(f, 2, { email: 'letters-2@example.test', signup: false }));
    const [sender, receiver, foreign] = accounts.map(a => a.controller);
    assert.equal(accounts.every(a => !a.requests.some(r => r.path.includes('/letters'))), true, 'no automatic letters traffic');
    sender.letters.setDraft('Synthetic private RAM draft');
    assert.equal(commands.length, 0);
    await receiver.letters.list(); assert.deepEqual(receiver.letters.getSnapshot().letters, []);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM letters')).rows[0].n, 0);
    await sender.letters.send(); assert.equal(sender.letters.getSnapshot().status, 'retry');
    sender.letters.setDraft('Synthetic later edited draft');
    await sender.letters.send(); assert.equal(sender.letters.getSnapshot().status, 'sent');
    assert.equal(sender.letters.getSnapshot().draft, 'Synthetic later edited draft');
    assert.deepEqual(commands[0], commands[1]);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM letters')).rows[0].n, 1);
    await receiver.letters.list(); const inbox = receiver.letters.getSnapshot();
    assert.equal(inbox.letters.length, 1); assert.equal(inbox.opened, null);
    assert.equal('body' in inbox.letters[0], false); assert.equal(inbox.letters[0].senderId, usersA[0]);
    await receiver.letters.open(inbox.letters[0].id);
    assert.equal(receiver.letters.getSnapshot().opened.body, 'Synthetic private RAM draft');
    receiver.letters.close(); assert.equal(receiver.letters.getSnapshot().opened, null);
    await foreign.letters.list(); assert.deepEqual(foreign.letters.getSnapshot().letters, []);
    await sender.letters.send(); assert.equal(sender.letters.getSnapshot().status, 'sent');
    assert.notEqual(commands[2].client_letter_id, commands[1].client_letter_id);
    assert.equal(commands[2].body, 'Synthetic later edited draft'); assert.equal(sender.letters.getSnapshot().draft, '');
    sender.letters.setDraft('Synthetic old epoch draft');
    await f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [pairA]);
    const posts = commands.length; await sender.letters.send(); assert.equal(commands.length, posts);
    assert.equal(sender.letters.getSnapshot().draft, '');
    await receiver.refresh(); assert.deepEqual(receiver.letters.getSnapshot().letters, []);
    await receiver.letters.list(); assert.deepEqual(receiver.letters.getSnapshot().letters, []);
    sender.letters.setDraft('Synthetic signout draft'); await sender.signOut();
    assert.equal(sender.letters.getSnapshot().available, false); assert.equal(sender.letters.getSnapshot().draft, '');
  } finally { await closeMobile(f, accounts); }
});
