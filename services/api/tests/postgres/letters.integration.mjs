import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lettersFixture } from './letters-fixture.mjs';

const metadata = ['availability', 'clientId', 'coupleId', 'createdAt', 'id', 'membershipEpoch', 'recipientId', 'releaseAt', 'releaseTimezone', 'senderId'];
test('real PostgreSQL letters: explicit send, private metadata list/open, cross-pair isolation and immutable retry', async () => {
  const { f, pairA, pairB, usersA, send, list, open, connections } = await lettersFixture();
  try {
    const id = randomUUID(); const body = "Synthetic <script>alert('x')</script> '); DROP TABLE letters;--\r\ne\u0301";
    const first = await send(0, id, body); assert.equal(first.status, 201);
    const sent = (await first.json()).value;
    assert.equal(sent.replay, false);
    assert.equal(sent.letter.releaseAt, null); assert.equal(sent.letter.releaseTimezone, null); assert.equal(sent.letter.availability, 'available');
    assert.equal(sent.letter.body, body.replace('\r\n', '\n').normalize('NFC'));
    assert.equal(sent.letter.senderId, usersA[0]); assert.equal(sent.letter.recipientId, usersA[1]);
    const letterId = sent.letter.id;
    assert.deepEqual((await (await list(0)).json()).value.letters, []);
    const received = (await (await list(1)).json()).value.letters;
    assert.equal(received.length, 1); assert.deepEqual(Object.keys(received[0]).sort(), metadata);
    assert.equal((await (await open(1, letterId)).json()).value.letter.body, sent.letter.body);
    for (const index of [0, 2, 3]) {
      const denied = await open(index, letterId); assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), await (await open(index, randomUUID())).json());
    }
    assert.equal((await list(null)).status, 401);
    assert.equal((await list(2)).status, 403);
    assert.equal((await send(0, randomUUID(), 'Synthetic', pairB)).status, 403);
    assert.equal((await open(1, letterId, pairB)).status, 403);
    assert.equal((await open(1, letterId, pairA, 2)).status, 409);
    // The ACK is deliberately discarded: retry must resolve the same persisted immutable letter.
    const unknownId = randomUUID(); await send(0, unknownId, 'Unknown ACK');
    const retry = await send(0, unknownId, 'Unknown ACK'); assert.equal(retry.status, 200);
    assert.equal((await retry.json()).value.replay, true);
    assert.equal((await send(0, unknownId, 'Edited body')).status, 409);
    assert.equal((await send(0, id, sent.letter.body)).status, 200, 'canonical-equivalent retry');
    assert.equal((await f.domainPool.query('SELECT count(*)::int AS n FROM letters')).rows[0].n, 2);
    assert.equal((await f.domainPool.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n, 0);
    const saved = await connections[1].getCookie(); await connections[1].auth.signOut();
    const revoked = await fetch(`${f.baseURL}/v1/couples/${pairA}/letters/${letterId}?membership_epoch=1`, {
      headers: { origin: f.baseURL, cookie: saved },
    });
    assert.equal(revoked.status, 401);
  } finally { await f.close(); }
});

test('real PostgreSQL letters: strict invalid HTTP requests never create content', async () => {
  const { f, raw, path, send, list } = await lettersFixture();
  try {
    for (const body of ['', ' \n', null, 3, '\u0000', '\uD800', 'x'.repeat(8001)]) {
      assert.equal((await send(0, randomUUID(), body)).status, 400);
    }
    for (const extra of [{ sender_id: randomUUID() }, { recipient_id: randomUUID() }, { release_at: '2099-01-01' }, { status: 'sealed' }]) {
      assert.equal((await send(0, randomUUID(), 'Synthetic', undefined, 1, extra)).status, 400);
    }
    for (const query of ['', '?membership_epoch=01', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&limit=99', '?membership_epoch=1&body=secret', '?membership_epoch=2147483647']) {
      assert.equal((await raw(0, path() + query)).status, 400);
    }
    const id = randomUUID(); const body = JSON.stringify({ client_letter_id: id, membership_epoch: 1, body: 'Synthetic' });
    assert.equal((await raw(0, path(), { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body })).status, 400);
    assert.equal((await raw(0, path() + '?body=secret', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id }, body })).status, 400);
    assert.equal((await raw(0, path(), { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).status, 415);
    assert.equal((await raw(0, path(), { method: 'DELETE' })).status, 405);
    assert.equal((await raw(0, path() + '/not-a-uuid?membership_epoch=1')).status, 400);
    assert.equal((await raw(0, path(), { headers: { origin: 'https://untrusted.example.test' } })).status, 403);
    assert.deepEqual((await (await list(1)).json()).value.letters, []);
    assert.equal((await f.domainPool.query('SELECT count(*)::int AS n FROM letters')).rows[0].n, 0);
  } finally { await f.close(); }
});

test('real PostgreSQL letters: concurrent identical and conflicting sends serialize; list bounded and ordered', async () => {
  const { f, send, list, pairA } = await lettersFixture();
  try {
    const id = randomUUID(); const responses = await Promise.all(Array.from({ length: 10 }, () => send(0, id)));
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    assert.equal(responses.filter(r => r.status === 200).length, 9);
    const results = await Promise.all(responses.map(r => r.json()));
    assert.equal(new Set(results.map(r => r.value.letter.id)).size, 1);
    const conflictId = randomUUID();
    const race = await Promise.all([send(0, conflictId, 'Synthetic A'), send(0, conflictId, 'Synthetic B')]);
    assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
    for (let n = 0; n < 31; n++) assert.equal((await send(0, randomUUID(), `Synthetic ${n}`)).status, 201);
    const letters = (await (await list(1)).json()).value.letters;
    assert.equal(letters.length, 30);
    for (const item of letters) assert.deepEqual(Object.keys(item).sort(), metadata);
    const expected = (await f.domainPool.query('SELECT id FROM letters WHERE couple_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30', [pairA])).rows.map(r => r.id);
    assert.deepEqual(letters.map(r => r.id), expected);
    await f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [pairA]);
    assert.equal((await send(0, id, 'Synthetic letter', pairA, 2)).status, 409);
    assert.deepEqual((await (await list(1, pairA, 2)).json()).value.letters, []);
  } finally { await f.close(); }
});

test('real PostgreSQL letters: migration constrains foreign members and rejects failed inserts atomically', async () => {
  const { f, pairA, usersA, usersB, send, list } = await lettersFixture();
  try {
    const insert = (sender, recipient, body = 'Synthetic', epoch = 1) => f.domainPool.query(`INSERT INTO letters
      (couple_id,sender_id,recipient_id,client_letter_id,membership_epoch,body,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())`,
    [pairA, sender, recipient, randomUUID(), epoch, body]);
    await assert.rejects(insert(usersB[0], usersA[1]), { code: '23503' });
    await assert.rejects(insert(usersA[0], usersB[1]), { code: '23503' });
    await assert.rejects(insert(usersA[0], usersA[0]), { code: '23514' });
    await assert.rejects(insert(usersA[0], usersA[1], 'x'.repeat(8001)), { code: '23514' });
    await assert.rejects(insert(usersA[0], usersA[1], 'Synthetic', 0), { code: '23514' });
    await f.domainPool.query(`CREATE FUNCTION reject_letters_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic DB failure, must be redacted'; END $$`);
    await f.domainPool.query('CREATE TRIGGER reject_letters_fixture BEFORE INSERT ON letters FOR EACH ROW EXECUTE FUNCTION reject_letters_fixture()');
    const id = randomUUID(); const failed = await send(0, id);
    assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { ok: false, error: 'temporarily_unavailable' });
    assert.deepEqual((await (await list(1)).json()).value.letters, []);
    await f.domainPool.query('DROP TRIGGER reject_letters_fixture ON letters');
    assert.equal((await send(0, id)).status, 201, 'failed write leaves no consumed command');
  } finally { await f.close(); }
});
