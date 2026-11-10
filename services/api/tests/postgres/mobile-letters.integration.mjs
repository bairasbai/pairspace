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

test('real PostgreSQL mobile scheduled letters: immutable unknown ACK, sealed refresh, client clock spoof and unchanged release', { timeout: 75000 }, async () => {
  const { f } = await lettersFixture(); const accounts = [];
  try {
    let loseAck = true; const commands = [];
    accounts.push(await mobile(f, 0, { email: 'letters-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.endsWith('/letters') && request.method === 'POST') commands.push(await request.clone().json());
      },
      afterResponse: async (record, response) => {
        if (record.path.endsWith('/letters') && record.method === 'POST' && loseAck) {
          assert.equal(response.status, 201); loseAck = false; throw new Error('Synthetic lost scheduled ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'letters-1@example.test', signup: false }));
    const [sender, receiver] = accounts.map(a => a.controller);
    const releaseMs = Date.now() + 61000; const releaseAt = new Date(releaseMs).toISOString();
    sender.letters.setDraft('Synthetic sealed mobile body');
    sender.letters.setReleaseAt(releaseAt); sender.letters.setReleaseTimezone('UTC');
    await sender.letters.sendLater(); assert.equal(sender.letters.getSnapshot().status, 'retry');
    sender.letters.setDraft('Synthetic newer body');
    sender.letters.setReleaseAt(new Date(releaseMs + 120000).toISOString()); sender.letters.setReleaseTimezone('Etc/GMT');
    await sender.letters.send(); assert.equal(sender.letters.getSnapshot().status, 'sent');
    assert.deepEqual(commands[1], commands[0], 'even send-now retries immutable scheduled command');
    assert.equal(sender.letters.getSnapshot().draft, 'Synthetic newer body');
    assert.equal(sender.letters.getSnapshot().releaseTimezoneInput, 'Etc/GMT');
    await receiver.letters.list(); const letter = receiver.letters.getSnapshot().letters[0];
    assert.equal(letter.releaseAt, releaseAt); assert.equal(letter.availability, 'sealed');
    assert.equal(Object.hasOwn(letter, 'body'), false); assert.equal(receiver.letters.getSnapshot().opened, null);
    const before = accounts[1].requests.length;
    // Simulate a badly set device clock around the controller action only, not server execution.
    const realNow = Date.now;
    try { Date.now = () => releaseMs + 86400000; await receiver.letters.open(letter.id); }
    finally { Date.now = realNow; }
    assert.equal(accounts[1].requests.length, before, 'client state remains sealed despite device clock');
    const url = `${f.baseURL}/v1/couples/${letter.coupleId}/letters/${letter.id}?membership_epoch=1`;
    const response = await fetch(url, { headers: { origin: f.baseURL, cookie: await accounts[1].connection.getCookie(), 'x-client-time': String(releaseMs + 86400000) } });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { ok: false, error: 'unavailable' });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, releaseMs - Date.now() + 100)));
    assert.equal(receiver.letters.getSnapshot().letters[0].availability, 'sealed', 'no auto-open or countdown unlock');
    await receiver.letters.list(); assert.equal(receiver.letters.getSnapshot().letters[0].availability, 'available');
    assert.equal(receiver.letters.getSnapshot().opened, null, 'refresh never opens the body');
    await receiver.letters.open(letter.id);
    assert.equal(receiver.letters.getSnapshot().opened.body, 'Synthetic sealed mobile body');
    const stored = (await f.domainPool.query('SELECT release_at,release_timezone FROM letters WHERE id=$1', [letter.id])).rows[0];
    assert.equal(stored.release_at.toISOString(), releaseAt, 'persisted immutable release was never altered by test');
    assert.equal(stored.release_timezone, 'UTC');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
  } finally { await closeMobile(f, accounts); }
});
