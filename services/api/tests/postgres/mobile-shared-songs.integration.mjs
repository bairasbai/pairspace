import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('real PostgreSQL: shared-song mobile immutable unknown ACK, separate new draft, explicit sharing and closure', async () => {
  const f = await createComposedFixture({ enableSyntheticSharedSongs: true, enableSyntheticPairLeave: true });
  const accounts = [];
  try {
    const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `song-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    await f.provision(identities.slice(0, 2), pairA); await f.provision(identities.slice(2), pairB);
    let drop = true, dropEdit = true; const commands = [], edits = [];
    accounts.push(await mobile(f, 0, { email: 'song-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.includes('/songs/') && record.method === 'PATCH') edits.push(await request.clone().json());
        if (record.path.includes('/songs') && record.method === 'POST') {
          const body = await request.clone().json(); commands.push(body);
          assert.equal(request.headers.get('idempotency-key'), body.command_id);
          assert.equal(request.url.includes(body.title), false);
        }
      },
      afterResponse: async (record, response) => {
        if (record.path.includes('/songs/') && record.method === 'PATCH' && dropEdit) {
          assert.equal(response.status, 200); dropEdit = false; throw new Error('Synthetic lost committed edit ACK');
        }
        if (record.path.includes('/songs') && record.method === 'POST' && drop) {
          assert.equal(response.status, 201); drop = false; throw new Error('Synthetic lost committed ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'song-mobile-1@example.test', signup: false }));
    accounts.push(await mobile(f, 2, { email: 'song-mobile-2@example.test', signup: false }));
    const [a, b, foreign] = accounts.map(account => account.controller);
    assert.equal(accounts.every(account => !account.requests.some(r => r.path.includes('/songs'))), true);
    a.songs.setDraft('Synthetic shared song'); a.songs.setExplanation('Synthetic shared explanation');
    const musicUrl = 'https://youtu.be/Synthetic123'; a.songs.setMusicUrl(musicUrl);
    await a.songs.create(); assert.equal(commands.length, 0, 'explicit sharing consent required');
    a.songs.setConsent(true);
    await b.songs.list(); assert.equal(b.songs.getSnapshot().songs.length, 0, 'private RAM draft not auto-shared');
    await a.songs.create(); assert.equal(a.songs.getSnapshot().status, 'retry');
    a.songs.setDraft('Synthetic new draft'); a.songs.setExplanation('Synthetic new explanation');
    a.songs.setMusicUrl('https://open.spotify.com/track/NewSynthetic');
    await a.songs.retry(); assert.equal(a.songs.getSnapshot().status, 'saved');
    assert.equal(a.songs.getSnapshot().draft, 'Synthetic new draft');
    assert.equal(a.songs.getSnapshot().explanation, 'Synthetic new explanation');
    assert.equal(a.songs.getSnapshot().musicUrl, 'https://open.spotify.com/track/NewSynthetic');
    assert.equal(commands[0].music_url, musicUrl); assert.deepEqual(commands[0], commands[1]);
    const song = a.songs.getSnapshot().songs[0]; assert.equal(song.musicUrl, musicUrl); assert.equal(song.explanation, 'Synthetic shared explanation');
    await b.songs.list(); assert.deepEqual(b.songs.getSnapshot().songs, [song]);
    await foreign.songs.list(); assert.equal(foreign.songs.getSnapshot().songs.length, 0);
    const cookie = await accounts[2].connection.getCookie();
    assert.equal((await fetch(`${f.baseURL}/v1/couples/${pairA}/songs?membership_epoch=1`,
      { headers: { cookie, origin: f.baseURL } })).status, 403);
    const persisted = (await f.domainPool.query('SELECT explanation,title,music_url FROM shared_songs')).rows;
    assert.deepEqual(persisted, [{ explanation: 'Synthetic shared explanation', title: 'Synthetic shared song', music_url: musicUrl }]);
    const ownerCookie = await accounts[0].connection.getCookie();
    a.songs.cancel(); a.songs.beginEdit(song.id); a.songs.setDraft('Synthetic first correction');
    a.songs.setExplanation('Synthetic corrected reason'); a.songs.setMusicUrl('');
    await a.songs.create(); assert.equal(edits.length, 0, 'editing requires renewed sharing consent');
    a.songs.setConsent(true); await a.songs.create(); assert.equal(a.songs.getSnapshot().status, 'retry');
    a.songs.setDraft('Synthetic preserved unsent correction');
    a.songs.setExplanation('Synthetic unsent explanation'); a.songs.setMusicUrl('https://youtu.be/Unsent');
    await b.songs.list(); assert.equal(b.songs.getSnapshot().songs[0].version, 2);
    assert.equal('musicUrl' in b.songs.getSnapshot().songs[0], false);
    b.songs.beginEdit(song.id); assert.equal(b.songs.getSnapshot().editing, null, 'partner cannot rewrite author content');
    const patchBody = { command_id: randomUUID(), membership_epoch: 1, expected_version: 2,
      title: 'Synthetic latest same-author correction', explanation: 'Synthetic latest reason', music_url: 'https://youtu.be/Latest' };
    const patch = async (sessionCookie, body) => fetch(`${f.baseURL}/v1/couples/${pairA}/songs/${song.id}`, {
      method: 'PATCH', headers: { cookie: sessionCookie, origin: f.baseURL, 'content-type': 'application/json', 'idempotency-key': body.command_id },
      body: JSON.stringify(body),
    });
    assert.equal((await patch(await accounts[1].connection.getCookie(), patchBody)).status, 403);
    assert.equal((await patch(cookie, patchBody)).status, 403);
    const newer = await patch(ownerCookie, patchBody); assert.equal(newer.status, 200);
    const canonical = (await newer.json()).value.song; assert.equal(canonical.version, 3);
    await a.songs.retry(); assert.equal(a.songs.getSnapshot().status, 'saved');
    assert.deepEqual(edits[0], edits[1]); assert.equal(edits.length, 2);
    assert.equal(a.songs.getSnapshot().draft, 'Synthetic preserved unsent correction');
    assert.equal(a.songs.getSnapshot().explanation, 'Synthetic unsent explanation');
    assert.equal(a.songs.getSnapshot().musicUrl, 'https://youtu.be/Unsent');
    assert.deepEqual(a.songs.getSnapshot().songs[0], canonical);
    const originalReplay = await fetch(`${f.baseURL}/v1/couples/${pairA}/songs`, { method: 'POST',
      headers: { cookie: ownerCookie, origin: f.baseURL, 'content-type': 'application/json', 'idempotency-key': commands[0].command_id },
      body: JSON.stringify(commands[0]) });
    assert.equal(originalReplay.status, 200); assert.deepEqual((await originalReplay.json()).value.song, canonical);
    a.songs.setConsent(true); await a.songs.create();
    assert.equal(a.songs.getSnapshot().status, 'conflict');
    assert.equal(a.songs.getSnapshot().draft, 'Synthetic preserved unsent correction');
    await b.songs.list(); assert.deepEqual(b.songs.getSnapshot().songs[0], canonical);

    const leave = await fetch(`${f.baseURL}/v1/pair/leave`, { method: 'POST',
      headers: { cookie: ownerCookie, origin: f.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), coupleId: pairA, membershipEpoch: 1, confirm: true }) });
    assert.equal(leave.status, 200);
    await a.songs.list(); assert.equal(a.songs.getSnapshot().available, false);
    assert.deepEqual(a.songs.getSnapshot().songs, []); assert.equal(a.songs.getSnapshot().draft, '');
    assert.equal(a.songs.getSnapshot().musicUrl, '');
    await b.refresh(); assert.deepEqual(b.songs.getSnapshot().songs, []);
    await foreign.songs.list(); assert.equal(foreign.songs.getSnapshot().available, true);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM shared_songs')).rows[0].n, 1, 'rows retained without deciding archive or retention policy');
  } finally { await closeMobile(f, accounts); }
});
