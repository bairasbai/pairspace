import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latch } from './mobile-reply-fixture.mjs';
import { password } from './mobile-invitations-fixture.mjs';
import { morningRequest as request, morningValue as value, morningCommand as command, morningAccount } from './mobile-mornings-fixture.mjs';
const path = (x, id, legacy = false) => `/slots/${x.slot.id}/discussion${legacy ? '' : '-v2'}${id ? '/' + id : ''}`;
const read = (x, actor = 0, query = {}, legacy = false) => request(x.f, x.connections[actor], x.pairA, path(x, null, legacy), { query: { direction: 'last', ...query } });
const create = (x, body) => request(x.f, x.connections[0], x.pairA, path(x), { method: 'POST', body });
const change = (x, id, body, method = 'PATCH', actor = 0) => request(x.f, x.connections[actor], x.pairA, path(x, id), { method, body });

export function registerMorningDiscussionEditingTests(context) {
  test('genuine discussion v2 noop/edit/restore keeps version and marker semantics; original create and edit receipts return current canonical', async () => {
    const x = context(), original = command({ body: 'Synthetic original editable reply\nSecond line' });
    const first = value(await create(x, original)).message;
    assert.equal(first.version, 1); assert.equal(first.editedAt, null); assert.equal(first.deletedAt, null);
    const noop = command({ expected_version: 1, body: original.body.replace('\n', '\r\n') });
    assert.equal(value(await change(x, first.id, noop)).message.version, 1);
    const editing = command({ expected_version: 1, body: 'Edited reply\nҺаумы 🦉' });
    const edited = value(await change(x, first.id, editing)).message;
    assert.equal(edited.version, 2); assert.notEqual(edited.editedAt, null);
    assert.equal(value(await change(x, first.id, command({ expected_version: 2, body: editing.body }))).message.version, 2);
    const restored = value(await change(x, first.id, command({ expected_version: 2, body: original.body }))).message;
    assert.equal(restored.version, 3); assert.notEqual(restored.editedAt, null);
    const retried = value(await change(x, first.id, editing));
    assert.equal(retried.replay, true); assert.equal(retried.message.version, 3); assert.equal(retried.message.body, original.body);
    const createReplay = value(await create(x, original));
    assert.equal(createReplay.replay, true); assert.equal(createReplay.message.version, 3);
    assert.equal((await create(x, { ...original, body: 'Changed original command payload' })).status, 409);
    assert.equal((await change(x, first.id, { ...editing, body: 'Changed immutable edit command' })).status, 409);
    const partner = value(await read(x, 1)).messages.find(m => m.id === first.id);
    assert.equal(partner.body, original.body); assert.equal(partner.version, 3); assert.notEqual(partner.editedAt, null);
    const deletion = command({ expected_version: 3, confirm: true });
    const deleted = value(await change(x, first.id, deletion, 'DELETE')).message;
    assert.equal(deleted.version, 4); assert.equal(deleted.body, null); assert.notEqual(deleted.deletedAt, null);
    assert.deepEqual(value(await create(x, original)).message, deleted);
    assert.deepEqual(value(await change(x, first.id, editing)).message, deleted);
    assert.deepEqual(value(await change(x, first.id, deletion, 'DELETE')).message, deleted);
    const stale = await change(x, first.id, command({ expected_version: 3, body: 'Must not resurrect' }));
    assert.equal(stale.status, 409); assert.equal(stale.payload.error, 'message_deleted');
    assert.deepEqual(stale.payload.value.message, deleted);
    const legacyReplay = await request(x.f, x.connections[0], x.pairA, path(x, null, true), { method: 'POST', body: original });
    assert.equal(legacyReplay.status, 403); assert.equal(JSON.stringify(legacyReplay).includes(original.body), false);
  });

  test('genuine discussion v2 owner-only mutations, competing CAS and delete/edit orders preserve canonical state', async () => {
    const x = context();
    const fresh = async body => value(await create(x, command({ body }))).message;
    const one = await fresh('Concurrent edit target');
    const rejected = await change(x, one.id, command({ expected_version: 1, body: 'Partner forbidden edit' }), 'PATCH', 1);
    assert.equal(rejected.status, 403);
    const outcomes = await Promise.all(['Concurrent A', 'Concurrent B'].map(body => change(x, one.id, command({ expected_version: 1, body }))));
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    const current = value(outcomes.find(r => r.status === 200)).message;
    assert.equal(current.version, 2);
    assert.equal((await change(x, one.id, command({ expected_version: 1, confirm: true }), 'DELETE')).status, 409);
    const removed = value(await change(x, one.id, command({ expected_version: 2, confirm: true }), 'DELETE')).message;
    assert.equal(removed.body, null); assert.equal(removed.version, 3);
    const two = await fresh('Delete wins before edit');
    value(await change(x, two.id, command({ expected_version: 1, confirm: true }), 'DELETE'));
    const late = await change(x, two.id, command({ expected_version: 1, body: 'Forbidden late edit' }));
    assert.equal(late.status, 409); assert.equal(late.payload.error, 'message_deleted'); assert.equal(late.payload.value.message.body, null);
    const foreign = await change(x, two.id, command({ expected_version: 2, confirm: true }), 'DELETE', 2);
    assert.equal(foreign.status, 403); assert.equal(Object.hasOwn(foreign.payload, 'value'), false);
  });

  test('genuine legacy history excludes deleted rows but accepts a deleted anchor and retains exact old DTO', async () => {
    const x = context(), first = value(await read(x, 0, { direction: 'first' }));
    assert.equal(first.messages.length, 30);
    const owned = first.messages.find(m => m.authorId === x.usersA[0] && m.deletedAt === null);
    assert.ok(owned);
    value(await change(x, owned.id, command({ expected_version: owned.version, confirm: true }), 'DELETE'));
    const all = []; let page = value(await read(x, 0, { direction: 'first' }, true));
    for (;;) {
      all.push(...page.messages); if (!page.hasNext) break;
      page = value(await read(x, 0, { direction: 'after', anchor_id: page.nextCursor.id, anchor_seq: page.nextCursor.seq }, true));
    }
    assert.equal(all.length > 30, true); assert.equal(new Set(all.map(m => m.id)).size, all.length);
    assert.equal(all.some(m => m.id === owned.id), false);
    for (const m of all) assert.deepEqual(Object.keys(m).sort(), ['id','slotId','coupleId','membershipEpoch','authorId','clientId','seq','body','createdAt'].sort());
    const anchored = value(await read(x, 0, { direction: 'after', anchor_id: owned.id, anchor_seq: owned.seq }, true));
    assert.equal(anchored.messages.every(m => m.seq > owned.seq), true);
    const v2 = value(await read(x, 1, { direction: 'first' }));
    assert.equal(v2.messages.find(m => m.id === owned.id).body, null);
  });

  test('genuine discussion mutation receipt failures roll back both edited body and terminal deletion without changing outbox', async () => {
    const x = context(), original = value(await create(x, command({ body: 'Receipt rollback original' }))).message;
    const events = (await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows;
    await x.f.domainPool.query(`CREATE FUNCTION fail_test_discussion_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic_mutation_receipt_failure'; END $$;
      CREATE TRIGGER fail_test_discussion_mutation BEFORE INSERT ON morning_discussion_mutation_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_test_discussion_mutation()`);
    try {
      const edit = await change(x, original.id, command({ expected_version: 1, body: 'Must not persist' }));
      assert.equal(edit.status, 503);
      const deleted = await change(x, original.id, command({ expected_version: 1, confirm: true }), 'DELETE');
      assert.equal(deleted.status, 503);
      const after = value(await read(x, 1)).messages.find(m => m.id === original.id);
      assert.deepEqual(after, original);
      assert.deepEqual((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows, events);
    } finally {
      await x.f.domainPool.query('DROP TRIGGER fail_test_discussion_mutation ON morning_discussion_mutation_receipts; DROP FUNCTION fail_test_discussion_mutation()');
    }
  });


  test('connected discussion editing: explicit cancel sends no PATCH, CAS conflict preserves draft, reload and partner refresh expose new marker', async () => {
    const x = context(), item = value(await create(x, command({ body: 'Controller own original' }))).message;
    let account, partner;
    try {
      account = await morningAccount(x.f, 0); partner = await morningAccount(x.f, 1);
      const slotA = value(await request(x.f, account.connection, x.pairA, `/slots/${x.slot.id}`)).slot;
      const slotB = value(await request(x.f, partner.connection, x.pairA, `/slots/${x.slot.id}`)).slot;
      const d = account.controller.morningDiscussions; await d.open(slotA); await d.last();
      d.beginEdit(item.id); d.setEditDraft('Cancelled edit'); d.cancelEdit();
      assert.equal(account.requests.filter(r => r.method === 'PATCH').length, 0);
      d.beginEdit(item.id); d.setEditDraft('Protected competing edit');
      value(await change(x, item.id, command({ expected_version: 1, body: 'Other device revision' })));
      await d.saveEdit();
      assert.equal(d.getSnapshot().editor.status, 'conflict'); assert.equal(d.getSnapshot().editor.needsReload, true);
      assert.equal(d.getSnapshot().editor.draft, 'Protected competing edit');
      await d.reloadEdit(); assert.equal(d.getSnapshot().editor.version, 2);
      assert.equal(d.getSnapshot().editor.draft, 'Protected competing edit');
      await d.saveEdit(); assert.equal(d.getSnapshot().editor.status, 'saved');
      const b = partner.controller.morningDiscussions; await b.open(slotB); await b.last();
      const canonical = b.getSnapshot().messages.find(m => m.id === item.id);
      assert.equal(canonical.body, 'Protected competing edit'); assert.equal(canonical.version, 3); assert.notEqual(canonical.editedAt, null);
      d.beginDelete(item.id); d.cancelDelete();
      assert.equal(account.requests.filter(r => r.method === 'DELETE').length, 0);
      d.beginDelete(item.id); await d.confirmDelete(d.getSnapshot().deletion.confirmation.token);
      await b.last(); assert.equal(b.getSnapshot().messages.find(m => m.id === item.id).body, null);
    } finally { if (account) await account.controller.signOut(); if (partner) await partner.controller.signOut(); }
  });

  test('connected discussion held live edit ACK cannot resurrect tombstone or clear a newer editor and composer draft', async () => {
    const x = context(), item = value(await create(x, command({ body: 'Original before held edit' }))).message;
    const gate = latch(); let account, pending;
    try {
      account = await morningAccount(x.f, 0, { afterResponse: async record => {
        if (record.method === 'PATCH') { gate.arrive(); await gate.gate; }
      } });
      const d = account.controller.morningDiscussions;
      await d.open(value(await request(x.f, account.connection, x.pairA, `/slots/${x.slot.id}`)).slot); await d.last();
      d.beginEdit(item.id); d.setEditDraft('Old ACK edited body'); pending = d.saveEdit(); await gate.reached;
      value(await change(x, item.id, command({ expected_version: 2, confirm: true }), 'DELETE'));
      d.setEditDraft('New private editor text'); d.setDraft('Separate new composer text');
      await d.last(); assert.equal(d.getSnapshot().messages.find(m => m.id === item.id).body, null);
      gate.release(); await pending; pending = null;
      const view = d.getSnapshot(); assert.equal(view.messages.find(m => m.id === item.id).body, null);
      assert.equal(view.editor.draft, 'New private editor text'); assert.equal(view.draft, 'Separate new composer text');
      assert.equal(JSON.stringify(view).includes('Old ACK edited body'), false);
      assert.equal(account.requests.filter(r => r.method === 'PATCH').length, 1);
    } finally { gate.release(); if (pending) await pending; if (account) await account.controller.signOut(); }
  });

  test('connected discussion held edit ACK cannot alter another slot composer or a newer account after signout', async () => {
    const x = context(), item = value(await create(x, command({ body: 'Old session editable original' }))).message;
    const gate = latch(); let account, pending;
    try {
      account = await morningAccount(x.f, 0, { afterResponse: async record => {
        if (record.method === 'PATCH') { gate.arrive(); await gate.gate; }
      } });
      const d = account.controller.morningDiscussions;
      await d.open(value(await request(x.f, account.connection, x.pairA, `/slots/${x.slot.id}`)).slot); await d.last();
      d.beginEdit(item.id); d.setEditDraft('Old session pending edit'); pending = d.saveEdit(); await gate.reached;
      await d.open(value(await request(x.f, account.connection, x.pairA, `/slots/${x.discussionSlot.id}`)).slot);
      d.setDraft('Other slot protected draft');
      assert.equal(d.getSnapshot().slot.id, x.discussionSlot.id); assert.equal(d.getSnapshot().draft, 'Other slot protected draft');
      await account.controller.signOut(); await account.controller.signIn('reply-2@example.test', password);
      account.controller.setDraft('Different account private chat'); gate.release(); await pending; pending = null;
      assert.equal(d.getSnapshot().slot, null); assert.equal(d.getSnapshot().draft, '');
      assert.deepEqual(d.getSnapshot().messages, []); assert.equal(d.getSnapshot().editor.draft, '');
      assert.equal(account.controller.getSnapshot().draft, 'Different account private chat');
    } finally { gate.release(); if (pending) await pending; if (account) await account.controller.signOut(); }
  });


  test('connected discussion unknown edit retry stays on A, returns current canonical once, and preserves B composer plus newer edit draft', async () => {
    const x = context(), item = value(await create(x, command({ body: 'Unknown edit original' }))).message;
    let account, lose = true; const commands = [];
    try {
      account = await morningAccount(x.f, 0, { beforeRequest: async (record, req) => {
        if (record.method === 'PATCH') commands.push({ path: record.path, body: await req.clone().json() });
      }, afterResponse: async record => {
        if (record.method === 'PATCH' && lose) { lose = false; throw Error('Synthetic lost mutation ACK'); }
      } });
      const d = account.controller.morningDiscussions;
      await d.open(value(await request(x.f, account.connection, x.pairA, `/slots/${x.slot.id}`)).slot); await d.last();
      d.beginEdit(item.id); d.setEditDraft('Exact committed unknown edit'); await d.saveEdit();
      assert.equal(d.getSnapshot().editor.status, 'unknown');
      await d.open(value(await request(x.f, account.connection, x.pairA, `/slots/${x.discussionSlot.id}`)).slot);
      d.setDraft('B composer survives A retry'); d.setEditDraft('Newer unpublished editor text');
      await d.retryEdit();
      assert.deepEqual(commands[1], commands[0]); assert.equal(d.getSnapshot().slot.id, x.discussionSlot.id);
      assert.equal(d.getSnapshot().draft, 'B composer survives A retry');
      assert.equal(d.getSnapshot().editor.draft, 'Newer unpublished editor text');
      const stored = (await x.f.domainPool.query('SELECT body,version FROM morning_discussion_messages WHERE id=$1', [item.id])).rows[0];
      assert.deepEqual(stored, { body: 'Exact committed unknown edit', version: 2 });
    } finally { if (account) await account.controller.signOut(); }
  });

}
