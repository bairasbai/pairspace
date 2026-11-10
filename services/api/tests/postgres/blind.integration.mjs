import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { blindFixture, value } from './blind-fixture.mjs';
import { pairAgain } from './pair-leave-fixture.mjs';
const keys = ['catalogVersion', 'coupleId', 'id', 'membershipEpoch', 'ownAnswer', 'partnerAnswer', 'questionId', 'revealed'];

test('blind PostgreSQL: one-sided answers never reveal body, length or submission status; mutual reveal is symmetric', async () => {
  const x = await blindFixture();
  try {
    assert.equal((await value(await x.read(0))).round, null);
    const opened = await x.open(0); assert.equal(opened.status, 201);
    const round = (await value(opened)).round;
    assert.deepEqual(Object.keys(round).sort(), keys);
    assert.equal(round.ownAnswer, null); assert.equal(round.partnerAnswer, null); assert.equal(round.revealed, false);
    const before = (await value(await x.read(1))).round;
    const a = await x.submit(0, round.id, 'Synthetic private A'); assert.equal(a.status, 200);
    assert.equal((await value(a)).round.ownAnswer, 'Synthetic private A');
    assert.deepEqual((await value(await x.read(1))).round, before, 'partner cannot infer submission or length');
    assert.equal((await value(await x.read(0))).round.partnerAnswer, null);
    const b = await x.submit(1, round.id, 'Synthetic private B'); assert.equal(b.status, 200);
    const revealed = (await value(b)).round;
    assert.equal(revealed.revealed, true); assert.equal(revealed.partnerAnswer, 'Synthetic private A');
    const final = (await value(await x.read(0))).round;
    assert.equal(final.revealed, true); assert.equal(final.partnerAnswer, 'Synthetic private B');
    assert.deepEqual(Object.keys(final).sort(), keys);
    assert.equal((await value(await x.open(1))).round.id, round.id, 'opening cannot create another round');
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
  } finally { await x.f.close(); }
});

test('blind PostgreSQL: concurrent opens and submissions converge; immutable command replay binds answer and round', async () => {
  const x = await blindFixture();
  try {
    const opening = randomUUID();
    const opened = await Promise.all([x.open(0, opening), x.open(0, opening), x.open(1)]);
    assert.ok(opened.every(r => [200, 201].includes(r.status)));
    const rounds = await Promise.all(opened.map(value));
    assert.equal(new Set(rounds.map(v => v.round.id)).size, 1);
    const id = rounds[0].round.id, command = randomUUID();
    const replies = await Promise.all([x.submit(0, id, 'Synthetic A', command), x.submit(1, id, 'Synthetic B'), x.submit(0, id, 'Synthetic A', command)]);
    assert.ok(replies.every(r => r.status === 200));
    const replay = await value(await x.submit(0, id, 'Synthetic A', command));
    assert.equal(replay.replay, true); assert.equal(replay.round.revealed, true); assert.equal(replay.round.partnerAnswer, 'Synthetic B');
    assert.equal((await x.submit(0, id, 'Synthetic edit', command)).status, 409);
    assert.equal((await x.submit(0, id, 'Synthetic edit')).status, 409);
    assert.equal((await x.submit(0, id, 'Synthetic A', opening)).status, 409);
    assert.equal((await x.submit(0, id, 'Synthetic A', command, x.pairA, 1, { catalog_version: 2 })).status, 400);
    for (const member of [0, 1]) assert.equal((await value(await x.read(member))).round.revealed, true);
  } finally { await x.f.close(); }
});

test('blind PostgreSQL: malicious round IDs, second pair, old epoch, closed and new pair cannot expose answers', async () => {
  const x = await blindFixture();
  try {
    const command = randomUUID(), round = (await value(await x.open(0, command))).round;
    await x.submit(0, round.id, 'Synthetic retained private answer');
    assert.equal((await x.read(null)).status, 401);
    for (const index of [2, 3]) {
      assert.equal((await x.read(index)).status, 403);
      assert.equal((await x.submit(index, round.id)).status, 403);
    }
    const other = (await value(await x.open(2, randomUUID(), x.pairB))).round;
    assert.equal((await x.submit(0, other.id)).status, 403);
    assert.equal((await x.submit(2, round.id, 'Synthetic', randomUUID(), x.pairB)).status, 403);
    assert.equal((await x.submit(0, randomUUID())).status, 403);
    assert.equal((await x.submit(0, 'not-uuid')).status, 400);
    assert.equal((await x.read(0, x.pairA, 2)).status, 409);
    assert.equal((await x.leave(1)).status, 200);
    assert.equal((await x.read(0)).status, 403); assert.equal((await x.submit(1, round.id)).status, 403);
    const fresh = await pairAgain(x.f, x.usersA);
    assert.equal((await value(await x.read(0, fresh))).round, null);
    assert.equal((await x.open(0, command, fresh)).status, 409);
    assert.equal((await x.submit(0, round.id, 'Synthetic', randomUUID(), fresh)).status, 403);
    assert.equal((await x.read(1)).status, 403);
  } finally { await x.f.close(); }
});

test('blind PostgreSQL: explicit consent and bounded normalized text; strict HTTP inputs leave answers untouched', async () => {
  const x = await blindFixture();
  try {
    const round = (await value(await x.open(0))).round;
    for (const answer of ['', '  ', '\u0000', '\uD800', 'x'.repeat(1001), null, 42]) {
      assert.equal((await x.submit(0, round.id, answer)).status, 400);
    }
    for (const extra of [{ confirm: false }, { partner_answer: 'Synthetic' }, { catalog_version: 2 }, { question_id: 'unknown' }]) {
      assert.equal((await x.submit(0, round.id, 'Synthetic', randomUUID(), x.pairA, 1, extra)).status, 400);
    }
    for (const suffix of ['', '?membership_epoch=01', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&answer=secret']) {
      assert.equal((await x.raw(0, x.path() + suffix)).status, 400);
    }
    assert.equal((await x.raw(0, x.path(), { method: 'DELETE' })).status, 405);
    assert.equal((await x.raw(0, x.path() + '?membership_epoch=1', { headers: { origin: 'https://untrusted.example.test' } })).status, 403);
    assert.equal((await value(await x.read(0))).round.ownAnswer, null);
    const submitted = await value(await x.submit(0, round.id, '  Synthetic e\u0301  '));
    assert.equal(submitted.round.ownAnswer, 'Synthetic é');
  } finally { await x.f.close(); }
});
