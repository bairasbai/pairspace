import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('blind rounds real PostgreSQL: mobile explicit history/selection, lost next ACK and round-bound answers', async () => {
  const f = await createComposedFixture({ enableSyntheticBlindAnswers: true }); const accounts = [];
  try {
    const identities = [];
    for (let index = 0; index < 2; index++) {
      const connection = client(f.baseURL);
      const signup = await connection.auth.signUp.email({ email: `rounds-mobile-${index}@example.test`, password, name: 'Synthetic' });
      assert.equal(signup.error, null); identities.push(signup.data.user.id);
    }
    await f.provision(identities, randomUUID());
    let dropNext = true, dropAnswer = true; const commands = [], answers = [];
    accounts.push(await mobile(f, 0, { email: 'rounds-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.endsWith('/next')) commands.push(await request.clone().json());
        if (record.path.endsWith('/answer')) answers.push({ path: record.path, body: await request.clone().json() });
      }, afterResponse: async (record, response) => {
        if (record.path.endsWith('/next') && dropNext) {
          assert.equal(response.status, 201); dropNext = false; throw new Error('Synthetic lost next ACK');
        }
        if (record.path.endsWith('/answer') && answers.length === 2 && dropAnswer) {
          assert.equal(response.status, 200); dropAnswer = false; throw new Error('Synthetic lost second answer ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'rounds-mobile-1@example.test', signup: false }));
    const [a, b] = accounts.map(x => x.controller.blind);
    assert.equal(accounts[0].requests.some(r => r.path.includes('blind-round')), false);
    await a.open(); await b.read(); const first = a.getSnapshot().round;
    for (const controller of [a, b]) { controller.setDraft('Synthetic first answer'); controller.setConsent(true); await controller.submit(); }
    await a.read(); await a.listRounds();
    await a.next('shared-plan', 1, false); assert.equal(commands.length, 0);
    await a.next('shared-plan', 1, true);
    assert.equal(a.getSnapshot().status, 'retry'); assert.equal(a.getSnapshot().round.id, first.id);
    await a.next('kind-memory', 1, true); assert.equal(commands.length, 1, 'cannot replace pending next');
    await a.retry(); assert.deepEqual(commands[0], commands[1]);
    const second = a.getSnapshot().round;
    assert.notEqual(second.id, first.id); assert.equal(second.questionId, 'shared-plan');
    await a.listRounds();
    await b.listRounds(); assert.equal(b.getSnapshot().round.id, first.id, 'history does not select or fetch a body');
    await b.selectRound(second.id); assert.equal(b.getSnapshot().round.id, second.id);
    a.setDraft('Synthetic second answer'); a.setConsent(true); await a.submit();
    assert.equal(a.getSnapshot().status, 'retry');
    await a.selectRound(first.id); assert.equal(a.getSnapshot().round.id, first.id);
    await a.selectRound(second.id); await a.retry();
    assert.deepEqual(answers[1], answers[2]);
    assert.ok(answers[1].path.includes(second.id)); assert.equal(answers[1].body.question_id, 'shared-plan');
    assert.equal(a.getSnapshot().round.partnerAnswer, null);
    b.setDraft('Synthetic second partner'); b.setConsent(true); await b.submit();
    await a.selectRound(second.id); assert.equal(a.getSnapshot().round.partnerAnswer, 'Synthetic second partner');
    await a.selectRound(first.id); assert.equal(a.getSnapshot().round.ownAnswer, 'Synthetic first answer');
    await a.listRounds(); assert.equal(a.getSnapshot().rounds.length, 2);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM blind_rounds')).rows[0].n, 2);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM blind_answers')).rows[0].n, 4);
  } finally { await closeMobile(f, accounts); }
});
