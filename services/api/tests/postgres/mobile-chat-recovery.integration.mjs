import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

const original = 'Synthetic immutable outgoing text';
const edited = 'Synthetic independently edited draft';

async function fixture(options = {}) {
  const f = await createComposedFixture();
  try {
    const identities = [];
    for (let index = 0; index < 2; index++) {
      const connection = client(f.baseURL);
      const account = await connection.auth.signUp.email({
        email: `chat-recovery-${index}@example.test`, password, name: 'Synthetic',
      });
      assert.equal(account.error === null, true);
      identities.push(account.data.user.id);
    }
    await f.provision(identities, randomUUID());
    const account = await mobile(f, 0, { email: 'chat-recovery-0@example.test', signup: false, ...options });
    assert.equal(account.controller.getSnapshot().phase, 'signed_in');
    return { f, account };
  } catch (error) { await f.close(); throw error; }
}

async function counts(f, expected) {
  for (const table of ['chat_messages', 'outbox_events']) {
    assert.equal((await f.domainPool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, expected);
  }
}

test('real PostgreSQL: lost chat ACK → edited composer → explicit immutable replay commits one message and outbox', async () => {
  const posts = [];
  let loseAck = true;
  const { f, account } = await fixture({
    async beforeRequest(record, request) {
      if (record.method === 'POST' && record.path.endsWith('/chat/messages')) {
        posts.push({ body: await request.clone().json(), key: request.headers.get('idempotency-key') });
      }
    },
    async afterResponse(record, response) {
      if (record.method !== 'POST' || !record.path.endsWith('/chat/messages')) return;
      if (loseAck) {
        loseAck = false;
        assert.equal(response.status, 201, 'server has committed before the client loses its response');
        throw new Error('synthetic lost response after COMMIT');
      }
      assert.equal(response.status, 200, 'exact replay returns the original committed result');
      assert.equal((await response.clone().json()).value.replay, true);
    },
  });
  const controller = account.controller;
  try {
    controller.setDraft(original);
    await controller.send();
    assert.equal(controller.getSnapshot().draft, original);
    assert.equal(controller.getSnapshot().outgoing.status, 'retry');
    assert.equal(posts.length, 1);
    await counts(f, 1);
    controller.setDraft(edited);
    await controller.send();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], posts[0], 'retry must preserve command ID, idempotency key, body and epoch');
    assert.equal(posts[0].body.body, original);
    assert.equal(controller.getSnapshot().draft, edited, 'ACK cannot erase a newer composer draft');
    await counts(f, 1);
    await controller.refresh();
    assert.equal(controller.getSnapshot().messages.length, 1);
    assert.equal(controller.getSnapshot().messages[0].body, original);
    assert.equal(controller.getSnapshot().outgoing.status, 'sent');
  } finally { await closeMobile(f, [account]); }
});

test('real PostgreSQL: transient context and history failures preserve draft without implicit POST', async () => {
  let failContext = false; let failHistory = false; let posts = 0;
  const { f, account } = await fixture({
    async beforeRequest(record) {
      if (record.path === '/v1/session/context' && failContext) {
        throw new Error('synthetic context connection interruption');
      }
      if (record.path.endsWith('/chat/messages')) {
        if (record.method === 'POST') posts++;
        else if (failHistory) throw new Error('synthetic history connection interruption');
      }
    },
  });
  const controller = account.controller;
  try {
    controller.setDraft(original);
    failContext = true;
    await controller.refresh();
    assert.equal(controller.getSnapshot().phase, 'signed_in');
    assert.equal(controller.getSnapshot().draft, original);
    await controller.send();
    assert.equal(controller.getSnapshot().draft, original);
    assert.equal(posts, 0);
    await counts(f, 0);
    failContext = false; failHistory = true;
    await controller.refresh();
    assert.equal(controller.getSnapshot().draft, original);
    assert.equal(posts, 0);
    failHistory = false;
    await controller.send();
    assert.equal(posts, 1);
    assert.equal(controller.getSnapshot().draft, '');
    assert.equal(controller.getSnapshot().messages.length, 1);
    await counts(f, 1);
  } finally { await closeMobile(f, [account]); }
});
