import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSharedDoingsFixture } from './shared-doings-fixture.mjs';
import { client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';
import { completeDoing } from '../../../../packages/domain/doings/state.ts';

test('real HTTP/mobile shared doing: voluntary join, own progress, lost ACK, canonical removal retry, completion withdrawal and epoch clear', async () => {
  const f = await createSharedDoingsFixture(), accounts = [], identities = [], proposals = [], joins = [], advances = [];
  const title = '🦉'.repeat(200); let loseProposal = true, loseJoin = true, loseAdvance = true;
  try {
    for (let n = 0; n < 4; n++) {
      const c = client(f.baseURL), result = await c.auth.signUp.email({ email: `doings-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true, 'official synthetic signup succeeds'); identities.push(result.data.user.id);
    }
    const a = randomUUID(), b = randomUUID(); await f.provision(identities.slice(0, 2), a); await f.provision(identities.slice(2), b);
    const path = `/v1/couples/${a}/shared-doings`;
    const hooks = recipient => ({ email: `doings-mobile-${recipient ? 1 : 0}@example.test`, signup: false,
      beforeRequest: async (record, request) => {
        if (!record.path.includes('/shared-doings') || record.method === 'GET') return;
        const payload = await request.clone().json(); assert.equal(request.headers.get('idempotency-key'), payload.command_id); assert.equal(payload.confirm, true);
        if (record.path === path && record.method === 'POST') proposals.push(payload);
        if (record.path.endsWith('/join')) joins.push(payload);
        if (recipient && record.path.endsWith('/advance')) advances.push(payload);
      },
      afterResponse: async (record, response) => {
        if (!record.path.includes('/shared-doings') || response.status !== 200) return;
        const value = (await response.clone().json()).value;
        if (!recipient && record.path === path && record.method === 'POST' && loseProposal) { loseProposal = false; throw Error('Synthetic lost committed proposal ACK'); }
        if (recipient && record.path.endsWith('/join') && loseJoin) { assert.equal(value.doing.recipientAt, 0); loseJoin = false; throw Error('Synthetic lost committed join ACK'); }
        if (recipient && record.path.endsWith('/advance') && loseAdvance) { loseAdvance = false; throw Error('Synthetic lost committed progress ACK'); }
      } });
    accounts.push(await mobile(f, 0, hooks(false)), await mobile(f, 1, hooks(true)), await mobile(f, 2, { email: 'doings-mobile-2@example.test', signup: false }));
    const [author, recipient, foreign] = accounts.map(account => account.controller), authorDoings = author.sharedDoings, recipientDoings = recipient.sharedDoings;
    assert.equal(accounts.every(account => !account.requests.some(r => r.path.includes('/shared-doings'))), true);
    await authorDoings.load(); authorDoings.setTitle(title); authorDoings.setKind('course'); authorDoings.setParts('3');
    await recipientDoings.load(); assert.equal(recipientDoings.getSnapshot().doings.length, 0, 'unsent draft stays in author RAM');
    await authorDoings.propose(false); assert.equal(proposals.length, 0);
    await authorDoings.propose(true); assert.equal(authorDoings.getSnapshot().status, 'retry');
    authorDoings.setTitle('Synthetic newer draft'); authorDoings.setKind('book'); authorDoings.setParts('5');
    await authorDoings.retry(); assert.deepEqual(proposals[0], proposals[1]);
    assert.deepEqual(authorDoings.getSnapshot().draft, { title: 'Synthetic newer draft', kind: 'book', parts: '5' });
    const first = authorDoings.getSnapshot().doings[0];
    await recipientDoings.load(); assert.equal(recipientDoings.getSnapshot().doings[0].title === title, true);
    assert.equal('recipientAt' in recipientDoings.getSnapshot().doings[0], false, 'an invitation never fabricates zero participation');
    await recipientDoings.advance(first.id, 1, true); assert.equal(advances.length, 0);
    await authorDoings.advance(first.id, 1, true); assert.equal(authorDoings.getSnapshot().status, 'saved');
    await recipientDoings.join(first.id, true); assert.equal(recipientDoings.getSnapshot().status, 'conflict', 'global CAS never silently accepts a stale participation choice');
    await recipientDoings.load(); const n = joins.length; await recipientDoings.join(first.id, false); assert.equal(joins.length, n);
    await recipientDoings.join(first.id, true); assert.equal(recipientDoings.getSnapshot().status, 'retry');
    await recipientDoings.load(); await recipientDoings.retry(); assert.deepEqual(joins.at(-2), joins.at(-1));
    assert.equal(recipientDoings.getSnapshot().doings[0].recipientAt, 0);
    await recipientDoings.advance(first.id, 2, true); assert.equal(recipientDoings.getSnapshot().status, 'retry');
    await authorDoings.load(); await authorDoings.remove(first.id, true); assert.equal(authorDoings.getSnapshot().status, 'saved');
    await recipientDoings.load(); const removed = recipientDoings.getSnapshot().doings[0]; assert.equal(removed.contentState, 'removed');
    await recipientDoings.retry(); assert.deepEqual(advances[0], advances[1]);
    assert.equal(recipientDoings.getSnapshot().status, 'saved'); assert.equal(recipientDoings.getSnapshot().pending, false);
    assert.deepEqual(recipientDoings.getSnapshot().doings[0], removed);
    assert.equal(['title', 'kind', 'parts', 'authorAt', 'recipientAt'].some(k => k in removed), false);
    assert.deepEqual((await f.domainPool.query('SELECT title,kind,parts,author_at,recipient_at FROM shared_doings WHERE id=$1', [first.id])).rows[0], { title: null, kind: null, parts: null, author_at: null, recipient_at: null });
    const headers = async index => ({ cookie: await accounts[index].connection.getCookie(), origin: f.baseURL });
    const historyURL = f.baseURL + path + '?membership_epoch=1';
    assert.equal((await fetch(historyURL, { headers: await headers(2) })).status, 403);
    assert.equal((await fetch(historyURL, { headers: { origin: f.baseURL } })).status, 401);
    const replay = await fetch(f.baseURL + path + '/' + first.id + '/advance', { method: 'POST', headers: { ...await headers(1), 'content-type': 'application/json', 'idempotency-key': advances[0].command_id }, body: JSON.stringify(advances[0]) });
    assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).value.doing, removed);
    await authorDoings.load(); authorDoings.setTitle('Synthetic second course'); authorDoings.setKind('course'); authorDoings.setParts('2'); await authorDoings.propose(true);
    const second = authorDoings.getSnapshot().doings.find(d => d.contentState === 'active'); assert.ok(second);
    await recipientDoings.load(); await recipientDoings.join(second.id, true); assert.equal(recipientDoings.getSnapshot().status, 'saved');
    await authorDoings.load(); await authorDoings.advance(second.id, 2, true);
    await recipientDoings.load(); await recipientDoings.advance(second.id, 2, true);
    assert.equal(completeDoing(recipientDoings.getSnapshot().doings.find(d => d.id === second.id)), true);
    await recipientDoings.decline(second.id, true); const declined = recipientDoings.getSnapshot().doings.find(d => d.id === second.id);
    assert.equal(declined.decisionState, 'declined'); assert.equal('recipientAt' in declined, false); assert.equal(completeDoing(declined), false); assert.equal(declined.authorAt, 2);
    await authorDoings.load(); const before = accounts[0].requests.length; await authorDoings.advance(second.id, 1, true); assert.equal(accounts[0].requests.length, before);
    await foreign.sharedDoings.load(); assert.equal(foreign.sharedDoings.getSnapshot().doings.length, 0);
    const leave = await fetch(f.baseURL + '/v1/pair/leave', { method: 'POST', headers: { ...await headers(0), 'content-type': 'application/json' }, body: JSON.stringify({ coupleId: a, membershipEpoch: 1, commandId: randomUUID(), confirm: true }) }); assert.equal(leave.status, 200);
    await recipientDoings.load(); assert.equal(recipientDoings.getSnapshot().available, false); assert.deepEqual(recipientDoings.getSnapshot().doings, []);
    await author.refresh(); assert.equal(authorDoings.getSnapshot().draft.title, ''); assert.equal((await fetch(historyURL, { headers: await headers(0) })).status, 403);
  } finally { await closeMobile(f, accounts); }
});
