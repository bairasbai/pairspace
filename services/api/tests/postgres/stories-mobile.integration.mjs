import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createStoriesFixture } from './stories-fixture.mjs';
import { client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('real HTTP mobile stories: long narrative, immutable lost ACK, explicit reader, split removal and epoch ACL', async () => {
  const f = await createStoriesFixture(), accounts = [], identities = [];
  const topic = 'Synthetic long-form recollection', body = '🦉'.repeat(4000) + '\n\n' + 'Ж'.repeat(3998);
  const commands = [], tellCommands = [];
  let loseOrder = true, loseTell = true;
  try {
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const signup = await connection.auth.signUp.email({ email: `story-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(signup.error === null, true, 'official synthetic signup succeeds');
      identities.push(signup.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    await f.provision(identities.slice(0, 2), pairA); await f.provision(identities.slice(2), pairB);
    const path = `/v1/couples/${pairA}/stories`;
    const hooks = teller => ({
      email: `story-mobile-${teller ? 1 : 0}@example.test`, signup: false,
      beforeRequest: async (record, request) => {
        if (!record.path.includes('/stories') || record.method === 'GET') return;
        const payload = await request.clone().json();
        assert.equal(request.headers.get('idempotency-key'), payload.command_id);
        assert.equal(request.url.includes(topic), false);
        if (record.method === 'POST' && record.path === path) commands.push(payload);
        if (record.method === 'POST' && record.path.endsWith('/story')) tellCommands.push(payload);
      },
      afterResponse: async (record, response) => {
        if (!record.path.includes('/stories') || response.status !== 200) return;
        const value = (await response.clone().json()).value;
        if (!record.path.endsWith('/text')) {
          assert.equal(Object.hasOwn(value, 'body'), false);
          const metadata = value.stories ?? [value.story];
          assert.equal(metadata.every(story => !Object.hasOwn(story, 'body')), true);
        }
        if (!teller && record.path === path && record.method === 'POST' && loseOrder) {
          loseOrder = false; throw Error('Synthetic lost committed order ACK');
        }
        if (teller && record.path.endsWith('/story') && record.method === 'POST' && loseTell) {
          loseTell = false; throw Error('Synthetic lost committed telling ACK');
        }
      },
    });
    accounts.push(await mobile(f, 0, hooks(false)), await mobile(f, 1, hooks(true)),
      await mobile(f, 2, { email: 'story-mobile-2@example.test', signup: false }));
    const [a, b, foreign] = accounts.map(account => account.controller);
    assert.equal(accounts.every(account => !account.requests.some(r => r.path.includes('/stories'))), true);
    await a.stories.load(); a.stories.setTopic(topic);
    await b.stories.load(); assert.equal(b.stories.getSnapshot().stories.length, 0, 'RAM topic stays private');
    await a.stories.order(); assert.equal(a.stories.getSnapshot().status, 'retry');
    a.stories.setTopic('Synthetic newer unsent topic'); await a.stories.retry();
    assert.equal(a.stories.getSnapshot().status, 'saved');
    assert.equal(a.stories.getSnapshot().topicDraft, 'Synthetic newer unsent topic');
    assert.deepEqual(commands[0], commands[1]);
    const story = a.stories.getSnapshot().stories[0];
    await b.stories.load(); b.stories.beginStory(story.id); b.stories.setStory(body);
    await a.stories.load(); assert.equal(a.stories.getSnapshot().stories[0].storyState, 'waiting');
    await b.stories.tell(); assert.equal(b.stories.getSnapshot().status, 'retry');
    b.stories.setStory('Synthetic newer unsent narrative'); await b.stories.retry();
    assert.equal(b.stories.getSnapshot().status, 'saved'); assert.deepEqual(tellCommands[0], tellCommands[1]);
    assert.equal(b.stories.getSnapshot().storyDraft.text, 'Synthetic newer unsent narrative');
    assert.equal(b.stories.getSnapshot().storyDraft.stale, 'terminal');
    assert.equal(b.stories.getSnapshot().opened, null, 'publication ACK never opens body');
    await a.stories.load(); assert.equal(a.stories.getSnapshot().opened, null);
    await a.stories.open(story.id); assert.equal(a.stories.getSnapshot().opened.body === body, true);
    a.stories.close(); assert.equal(a.stories.getSnapshot().opened, null);
    await b.stories.open(story.id); assert.equal(b.stories.getSnapshot().opened.body === body, true);
    await foreign.stories.load(); assert.equal(foreign.stories.getSnapshot().stories.length, 0);
    const headers = async i => ({ cookie: await accounts[i].connection.getCookie(), origin: f.baseURL });
    assert.equal((await fetch(f.baseURL + path + `/${story.id}/text?membership_epoch=1`, { headers: await headers(2) })).status, 403);
    assert.equal((await fetch(f.baseURL + path + '?membership_epoch=1', { headers: { origin: f.baseURL } })).status, 401);
    await a.stories.removeTopic(story.id, true); assert.equal(a.stories.getSnapshot().stories[0].topicState, 'removed');
    await b.stories.load(); assert.equal(b.stories.getSnapshot().opened, null, 'metadata version invalidates open reader');
    await b.stories.open(story.id); assert.equal(b.stories.getSnapshot().opened.body === body, true, 'other authored part survives');
    await b.stories.removeStory(story.id, true); assert.equal(b.stories.getSnapshot().opened, null);
    await a.stories.load(); assert.equal(a.stories.getSnapshot().stories[0].storyState, 'story_removed');
    const replay = await fetch(f.baseURL + path + `/${story.id}/story`, { method: 'POST',
      headers: { ...await headers(1), 'content-type': 'application/json', 'idempotency-key': tellCommands[0].command_id },
      body: JSON.stringify(tellCommands[0]) });
    assert.equal(replay.status, 200); const canonical = (await replay.json()).value;
    assert.equal(canonical.replay, true); assert.equal(canonical.story.storyState, 'story_removed');
    assert.equal(Object.hasOwn(canonical.story, 'body'), false);
    assert.deepEqual((await f.domainPool.query('SELECT topic,body FROM ordered_stories WHERE id=$1', [story.id])).rows[0], { topic: null, body: null });
    const leave = await fetch(f.baseURL + '/v1/pair/leave', { method: 'POST',
      headers: { ...await headers(0), 'content-type': 'application/json' },
      body: JSON.stringify({ coupleId: pairA, membershipEpoch: 1, commandId: randomUUID(), confirm: true }) });
    assert.equal(leave.status, 200);
    await b.stories.load(); assert.equal(b.stories.getSnapshot().available, false);
    assert.equal(b.stories.getSnapshot().storyDraft, null); assert.equal(b.stories.getSnapshot().opened, null);
    await a.refresh(); assert.equal(a.stories.getSnapshot().topicDraft, '');
    assert.equal((await fetch(f.baseURL + path + '?membership_epoch=1', { headers: await headers(0) })).status, 403);
  } finally { await closeMobile(f, accounts); }
});
