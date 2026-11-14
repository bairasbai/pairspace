import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { visibilityRequest, setVisibility, requireSuccess } from './chat-visibility-http-fixture.mjs';
import { replyFixture } from './mobile-reply-fixture.mjs';
import { journalChild, journalDirectory, assertCiphertext } from './journal-process-fixture.mjs';
const call = (child, method, args = [], journal = false) => child.send({ op: 'call', method, args, journal });
const posts = state => state.requests.filter(r => r.method === 'POST' && /\/chat\/(messages|replies)$/.test(r.path));
async function verified(child) { await child.send({ op: 'signIn' }); return call(child, 'check', [], true); }

// Real SIGKILL/new process, real Linux SQLite files and AES-GCM platform adapters.
// This does not substitute for Expo native-device/keystore durability verification.
test('real process restart: encrypted 8000-codepoint draft is inaccessible before verification and restored only explicitly', async () => {
  const { f } = await replyFixture(0); const directory = await journalDirectory(); let child;
  const prefix = 'Синтетика: һаумы\nHello café\n日本語 👩🏽‍💻\n';
  const draft = prefix + '🦉'.repeat(8000 - [...prefix].length);
  assert.equal([...draft].length, 8000); assert.equal(Buffer.byteLength(draft) > 2048, true);
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', [draft]); const saved = await call(child, 'flush', [], true);
    assert.equal(saved.result, true); await assertCiphertext(directory, [draft]);
    await child.kill(); child = await journalChild(f, directory);
    const locked = await child.send({ op: 'snapshot' }); assert.equal(locked.crypto.opens, 0); assert.equal(locked.view.draft, '');
    const inspected = await verified(child); assert.equal(inspected.view.draft, ''); assert.equal(inspected.journal.hasDraft, true);
    assert.equal(posts(inspected).length, 0);
    const restored = await call(child, 'restore', [], true);
    assert.equal(restored.view.draft === draft, true); assert.equal(posts(restored).length, 0);
    await assertCiphertext(directory, [draft]);
  } finally { if (child) await child.kill(); await f.close(); }
});

for (const crashPoint of ['prepared', 'server-committed', 'before-settle']) {
  test(`real process restart: ${crashPoint} crash retains an exact reply command and separately newer draft`, async () => {
    const { f, pairA, rows } = await replyFixture(1); const directory = await journalDirectory(); let child, sending;
    const body = `Synthetic journal original ${crashPoint}`, draft = `Newer independent draft ${crashPoint}`;
    try {
      child = await journalChild(f, directory); await verified(child);
      await call(child, 'setReplyTarget', [rows[0].id]); await call(child, 'setDraft', [body]); await call(child, 'flush', [], true);
      await child.send({ op: 'arm', name: crashPoint });
      if (crashPoint === 'before-settle') await child.send({ op: 'arm', name: 'server-committed' });
      sending = call(child, 'send'); await child.barrier(crashPoint === 'before-settle' ? 'server-committed' : crashPoint);
      await call(child, 'setDraft', [draft]); await call(child, 'flush', [], true);
      if (crashPoint === 'before-settle') {
        await child.send({ op: 'release', name: 'server-committed' }); await child.barrier('before-settle');
      }
      const before = await child.send({ op: 'snapshot' });
      if (crashPoint === 'prepared') assert.equal(posts(before).length, 0, 'durable prepare precedes HTTP POST');
      else assert.equal(posts(before).length, 1);
      await assertCiphertext(directory, [body, draft]);
      await child.kill(); await sending.catch(() => {}); sending = null;
      child = await journalChild(f, directory); await verified(child);
      const restored = await call(child, 'restore', [], true);
      assert.equal(restored.view.draft, draft); assert.equal(restored.view.outgoingPending, true);
      assert.equal(restored.view.outgoing, undefined, 'restored pending is metadata-only, not a plaintext outgoing preview');
      assert.equal(posts(restored).length, 0, 'recovery never sends automatically');
      await call(child, 'send'); const result = await child.send({ op: 'snapshot' });
      assert.equal(result.view.outgoingPending, undefined); assert.equal(result.view.draft, draft);
      const stored = (await f.domainPool.query('SELECT body,reply_to_id,client_message_id FROM chat_messages WHERE couple_id=$1 AND reply_to_id IS NOT NULL', [pairA])).rows;
      assert.equal(stored.length, 1); assert.equal(stored[0].body, body); assert.equal(stored[0].reply_to_id, rows[0].id);
      assert.equal(posts(result).length, 1); assert.equal(posts(result)[0].clientId, stored[0].client_message_id);
      if (crashPoint !== 'prepared') assert.equal(posts(before)[0].clientId, stored[0].client_message_id);
      await call(child, 'flush', [], true); await assertCiphertext(directory, [body, draft]);
    } finally { if (child) await child.kill(); if (sending) await sending.catch(() => {}); await f.close(); }
  });
}

test('real process journal: failed SQLite commit prevents POST and preserves the unsaved draft', async () => {
  const { f, pairA } = await replyFixture(0); const directory = await journalDirectory(); let child;
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', ['Synthetic storage failure draft']); await call(child, 'flush', [], true);
    await child.send({ op: 'fail-next-commit' }); const failed = await call(child, 'send');
    assert.equal(posts(failed).length, 0); assert.equal(failed.view.draft, 'Synthetic storage failure draft');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1', [pairA])).rows[0].n, 0);
  } finally { if (child) await child.kill(); await f.close(); }
});

test('real process journal: logout retirement rejects a delayed old writer and leaves no recoverable old body', async () => {
  const { f } = await replyFixture(0); const directory = await journalDirectory(); let child, delayed;
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', ['Private before logout']); await call(child, 'flush', [], true);
    await child.send({ op: 'arm', name: 'old-writer' });
    delayed = child.send({ op: 'delayed-engine-draft', draft: { revision: 999, text: 'Old writer cannot revive me' } });
    await child.barrier('old-writer'); await call(child, 'signOut');
    await child.send({ op: 'release', name: 'old-writer' }); const rejected = await delayed; delayed = null;
    assert.equal(rejected.ok, false); assert.equal(rejected.error, 'stale');
    await child.kill(); child = await journalChild(f, directory); await verified(child);
    const restored = await call(child, 'restore', [], true);
    assert.equal(restored.view.draft, ''); assert.equal(restored.view.outgoingPending, undefined);
    assert.equal(JSON.stringify(restored).includes('Old writer cannot revive me'), false);
  } finally { if (child) await child.kill(); if (delayed) await delayed.catch(() => {}); await f.close(); }
});

test('real process journal: changed account or revoked pair cannot disclose encrypted former-scope text', async () => {
  const { f, pairA } = await replyFixture(0); const directory = await journalDirectory(); let child;
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', ['Former account encrypted draft']); await call(child, 'flush', [], true); await child.kill();
    child = await journalChild(f, directory); await child.send({ op: 'signIn', email: 'reply-2@example.test' });
    const changed = await call(child, 'restore', [], true);
    assert.equal(changed.view.draft, ''); assert.equal(JSON.stringify(changed).includes('Former account encrypted draft'), false);
    assert.equal(posts(changed).length, 0); await child.kill();
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', ['Pair revoked encrypted draft']); await call(child, 'flush', [], true); await child.kill();
    await f.domainPool.query("WITH closed AS (UPDATE couples SET status='closed',membership_epoch=membership_epoch+1 WHERE id=$1 RETURNING id) UPDATE couple_members SET status='revoked' WHERE couple_id IN(SELECT id FROM closed)", [pairA]);
    child = await journalChild(f, directory); const denied = await child.send({ op: 'signIn' });
    await call(child, 'restore', [], true); const final = await child.send({ op: 'snapshot' });
    assert.notEqual(denied.view.phase, 'signed_in'); assert.equal(final.view.draft, '');
    assert.equal(final.crypto.opens, 0); assert.equal(posts(final).length, 0);
  } finally { if (child) await child.kill(); await f.close(); }
});

test('real process journal: tampered AES-GCM ciphertext fails closed after restart', async () => {
  const { f } = await replyFixture(0); const directory = await journalDirectory(); let child;
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', ['Synthetic authenticated ciphertext']); await call(child, 'flush', [], true); await child.kill();
    const db = new DatabaseSync(path.join(directory, 'journal.sqlite'));
    const row = JSON.parse(db.prepare('SELECT value FROM journal WHERE singleton=1').get().value);
    const data = Buffer.from(row.sealed.data, 'base64'); data[data.length - 1] ^= 1; row.sealed.data = data.toString('base64');
    db.prepare('UPDATE journal SET value=? WHERE singleton=1').run(JSON.stringify(row)); db.close();
    child = await journalChild(f, directory); await verified(child); const corrupt = await call(child, 'restore', [], true);
    assert.equal(corrupt.view.draft, ''); assert.equal(corrupt.journal.error, 'corrupt'); assert.equal(posts(corrupt).length, 0);
  } finally { if (child) await child.kill(); await f.close(); }
});

test('real process journal: missing synthetic key locks recovery without POST or plaintext fallback', async () => {
  const { f } = await replyFixture(0); const directory = await journalDirectory(); let child;
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', ['Synthetic lost-key private draft']); await call(child, 'flush', [], true); await child.kill();
    await unlink(path.join(directory, 'synthetic-vault.json'));
    child = await journalChild(f, directory); await verified(child); const locked = await call(child, 'restore', [], true);
    assert.equal(locked.view.draft, ''); assert.equal(locked.journal.error, 'locked');
    assert.equal(posts(locked).length, 0); assert.equal(locked.crypto.opens, 0);
  } finally { if (child) await child.kill(); await f.close(); }
});

for (const deleted of [false, true]) {
  test(`real process restart: hidden ${deleted ? 'deleted' : 'live'} canonical retry settles without resurfacing persisted pending text`, async () => {
    const { f, pairA, connections } = await replyFixture(0); const directory = await journalDirectory(); let child, sending;
    const body = `Synthetic original hidden ${deleted}`, draft = `Independent new draft ${deleted}`;
    try {
      child = await journalChild(f, directory); await verified(child);
      await call(child, 'setDraft', [body]); await call(child, 'flush', [], true);
      await child.send({ op: 'arm', name: 'server-committed' }); sending = call(child, 'send'); await child.barrier('server-committed');
      await call(child, 'setDraft', [draft]); await call(child, 'flush', [], true);
      const before = await child.send({ op: 'snapshot' }); const id = posts(before)[0].clientId;
      await child.kill(); await sending.catch(() => {}); sending = null;
      const stored = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 AND client_message_id=$2', [pairA, id])).rows[0];
      if (deleted) requireSuccess(await visibilityRequest(f, connections[0], pairA, `messages/${stored.id}`, { method: 'DELETE', body: {
        membership_epoch: 1, command_id: randomUUID(), expected_version: 1, scope: 'everyone',
      } }));
      requireSuccess(await setVisibility(f, connections[0], pairA, stored.id, true));
      child = await journalChild(f, directory); await verified(child);
      const restored = await call(child, 'restore', [], true);
      assert.equal(restored.view.outgoingPending, true); assert.equal(restored.view.outgoing, undefined);
      assert.equal(JSON.stringify(restored).includes(body), false); assert.equal(posts(restored).length, 0);
      const resolved = await call(child, 'send'); await call(child, 'flush', [], true);
      assert.equal(resolved.view.outgoingPending, undefined); assert.equal(resolved.view.outgoing, undefined);
      assert.equal(resolved.view.draft, draft); assert.equal(JSON.stringify(resolved).includes(body), false);
      assert.equal(posts(resolved).length, 1); assert.equal(posts(resolved)[0].clientId, id);
      await child.kill(); child = await journalChild(f, directory); await verified(child);
      const final = await call(child, 'restore', [], true);
      assert.equal(final.view.outgoingPending, undefined); assert.equal(final.view.draft, draft);
      assert.equal(JSON.stringify(final).includes(body), false);
      assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1 AND client_message_id=$2', [pairA, id])).rows[0].n, 1);
    } finally { if (child) await child.kill(); if (sending) await sending.catch(() => {}); await f.close(); }
  });
}


test('real process journal: failed new draft write retains the newer RAM text as unsaved without HTTP send', async () => {
  const { f } = await replyFixture(0); const directory = await journalDirectory(); let child;
  const newer = 'Новый несохранённый текст\nEmoji 🦉 and 日本語';
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', ['Previous committed draft']); await call(child, 'flush', [], true);
    await child.send({ op: 'fail-next-commit' }); await call(child, 'setDraft', [newer]);
    const failed = await call(child, 'flush', [], true);
    assert.equal(failed.result, false); assert.equal(failed.view.draft, newer);
    assert.equal(failed.journal.status, 'unsaved'); assert.equal(failed.journal.error, 'storage_error');
    assert.equal(posts(failed).length, 0); await assertCiphertext(directory, [newer, 'Previous committed draft']);
  } finally { if (child) await child.kill(); await f.close(); }
});


test('real process restart: explicit discard before prepare/client ID durably removes saved composer without POST', async () => {
  const { f, pairA } = await replyFixture(0); const directory = await journalDirectory(); let child, sending;
  const body = 'Сохранённый текст до подготовки\n日本語 🦉 '.repeat(100);
  try {
    child = await journalChild(f, directory); await verified(child);
    await call(child, 'setDraft', [body]); await call(child, 'flush', [], true);
    await child.send({ op: 'arm', name: 'second-context' });
    sending = call(child, 'send'); await child.barrier('second-context');
    const confirming = await call(child, 'beginDiscardOutgoing');
    assert.equal(confirming.view.discardConfirmation.clientId, null, 'no client ID or durable pending prepared yet');
    assert.equal(confirming.view.discardConfirmation.wasInFlight, true);
    const discarded = await call(child, 'confirmDiscardOutgoing', [confirming.view.discardConfirmation.token]);
    assert.equal(discarded.view.draft, ''); assert.equal(discarded.view.outgoingPending, undefined);
    assert.equal(posts(discarded).length, 0); await assertCiphertext(directory, [body]);
    await child.kill(); await sending.catch(() => {}); sending = null;
    child = await journalChild(f, directory); await verified(child);
    const restored = await call(child, 'restore', [], true);
    assert.equal(restored.view.draft, ''); assert.equal(restored.view.outgoingPending, undefined);
    assert.equal(restored.view.outgoing, undefined); assert.equal(posts(restored).length, 0);
    assert.equal(JSON.stringify(restored).includes(body), false);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1', [pairA])).rows[0].n, 0);
  } finally { if (child) await child.kill(); if (sending) await sending.catch(() => {}); await f.close(); }
});
