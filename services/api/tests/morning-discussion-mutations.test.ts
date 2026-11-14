import { it, expect } from 'vitest';
import { discussionFixture } from './morning-discussions.fixture.ts';
import { principal, identityPrincipal, u2, id, c1 } from './fixtures.ts';
import { sendMorningDiscussion, readMorningDiscussion } from '../src/morning-discussions.ts';
import { mutateMorningDiscussion } from '../src/morning-discussion-mutations.ts';
import { createMorningDiscussionV2Handler } from '../src/morning-discussion-v2-http.ts';
const scope = { coupleId: c1, membershipEpoch: 1, slotId: id(9000) };
const original = { ...scope, commandId: id(8000), body: 'Original' };
const read = { ...scope, readId: id(8001), direction: 'first' };
async function seed() {
    const f = discussionFixture();
    const sent = await sendMorningDiscussion(f.db, principal, original, true);
    if (!sent.ok)
        throw Error('seed');
    return Object.assign(f, { messageId: sent.value.message.id });
}
const edit = (messageId: string, expectedVersion = 1, body = 'Changed', commandId = id(8002)) => ({ ...scope, messageId, expectedVersion, commandId, body });
const del = (messageId: string, expectedVersion = 1, commandId = id(8003)) => ({ ...scope, messageId, expectedVersion, commandId, confirm: true });
it('samebody no-op, real edit marker, original restore, immutable create replay and terminal deletion', async () => {
    const f = await seed();
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 1, 'Original'), 'edit')).toMatchObject({ ok: true, value: { replay: false, message: { body: 'Original', version: 1, editedAt: null } } });
    expect(f.mutations).toHaveLength(1);
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 1, 'Changed', id(8004)), 'edit')).toMatchObject({ ok: true, value: { message: { version: 2, editedAt: new Date(f.flags.now).toISOString() } } });
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 1, 'Original'), 'edit')).toMatchObject({ ok: true, value: { replay: true, message: { version: 2, body: 'Changed' } } });
    expect(await sendMorningDiscussion(f.db, principal, original, true)).toMatchObject({ ok: true, value: { replay: true, message: { version: 2, body: 'Changed' } } });
    expect(await sendMorningDiscussion(f.db, principal, original)).toMatchObject({ ok: true, value: { message: { body: 'Changed' } } });
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 2, 'Changed', id(8005)), 'edit')).toMatchObject({ ok: true, value: { message: { version: 2 } } });
    f.flags.now = '2026-11-11T12:00:00.000Z';
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 2, 'Original', id(8006)), 'edit')).toMatchObject({ ok: true, value: { message: { version: 3, body: 'Original', editedAt: '2026-11-12T12:00:00.000Z' } } });
    const deleted = await mutateMorningDiscussion(f.db, principal, del(f.messageId, 3), 'delete');
    expect(deleted).toMatchObject({ ok: true, value: { message: { version: 4, body: null, deletedAt: '2026-11-12T12:00:00.000Z', editedAt: '2026-11-12T12:00:00.000Z' } } });
    expect(await sendMorningDiscussion(f.db, principal, original, true)).toMatchObject({ ok: true, value: { message: { body: null, version: 4 } } });
    expect(await sendMorningDiscussion(f.db, principal, original)).toEqual({ ok: false, error: 'unavailable' });
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 1, 'Original'), 'edit')).toMatchObject({ ok: true, value: { replay: true, message: { body: null, version: 4 } } });
    const count = f.mutations.length;
    expect(await mutateMorningDiscussion(f.db, principal, del(f.messageId, 4, id(8007)), 'delete')).toMatchObject({ ok: false, error: 'message_deleted', value: { commandId: id(8007), message: { body: null, version: 4 } } });
    expect(f.mutations).toHaveLength(count);
    expect(await mutateMorningDiscussion(f.db, principal, del(f.messageId, 3), 'delete')).toMatchObject({ ok: true, value: { replay: true, message: { body: null } } });
    expect(await readMorningDiscussion(f.db, principal, read)).toMatchObject({ ok: true, value: { messages: [], hasNext: false, hasPrevious: false } });
    expect(await readMorningDiscussion(f.db, principal, read, true)).toMatchObject({ ok: true, value: { messages: [{ body: null, version: 4 }] } });
    expect(await readMorningDiscussion(f.db, principal, { ...read, direction: 'after', anchorId: f.messageId, anchorSeq: 3 })).toMatchObject({ ok: true, value: { messages: [] } });
});
it('CAS, ownership, key namespace, receipt rollback and reauthorization are fail closed', async () => {
    const f = await seed();
    expect(await mutateMorningDiscussion(f.db, identityPrincipal(u2), edit(f.messageId), 'edit')).toEqual({ ok: false, error: 'unavailable' });
    expect(await mutateMorningDiscussion(f.db, principal, edit(id(7777)), 'edit')).toEqual({ ok: false, error: 'unavailable' });
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 2, 'Original'), 'edit')).toEqual({ ok: false, error: 'version_conflict' });
    f.flags.failReceipt = true;
    await expect(mutateMorningDiscussion(f.db, principal, edit(f.messageId), 'edit')).rejects.toThrow('synthetic_receipt_failure');
    await expect(mutateMorningDiscussion(f.db, principal, edit(f.messageId, 1, 'Original'), 'edit')).rejects.toThrow('synthetic_receipt_failure');
    expect((await readMorningDiscussion(f.db, principal, read, true))).toMatchObject({ ok: true, value: { messages: [{ body: 'Original', version: 1 }] } });
    f.flags.failReceipt = false;
    f.flags.zeroUpdate = true;
    expect(await mutateMorningDiscussion(f.db, principal, edit(f.messageId), 'edit')).toEqual({ ok: false, error: 'version_conflict' });
    f.flags.zeroUpdate = false;
    expect((await mutateMorningDiscussion(f.db, principal, edit(f.messageId, 1, 'Changed', original.commandId), 'edit')).ok).toBe(true);
    expect(await mutateMorningDiscussion(f.db, principal, del(f.messageId, 2, original.commandId), 'delete')).toEqual({ ok: false, error: 'idempotency_conflict' });
    const revoked = await seed();
    // Four checks during create, then three access checks + final target-lock check during mutation.
    revoked.flags.denyCheck = 7;
    expect(await mutateMorningDiscussion(revoked.db, principal, edit(revoked.messageId), 'edit')).toEqual({ ok: false, error: 'unavailable' });
    const gated = await seed();
    gated.flags.allowed = false;
    expect(await mutateMorningDiscussion(gated.db, principal, edit(gated.messageId), 'edit')).toEqual({ ok: false, error: 'unavailable' });
    for (const input of [null, {}, { ...edit(f.messageId), expectedVersion: 0 }, { ...edit(f.messageId), body: ' ' }, { ...edit(f.messageId), extra: true }])
        expect(await mutateMorningDiscussion(f.db, principal, input, 'edit')).toEqual({ ok: false, error: 'invalid_request' });
    expect(await mutateMorningDiscussion(f.db, principal, { ...del(f.messageId), confirm: false }, 'delete')).toEqual({ ok: false, error: 'invalid_request' });
});
it('v2 HTTP strict mutation envelopes, canonical terminal error, old routing and nonce', async () => {
    const f = await seed(), handler = createMorningDiscussionV2Handler(f.db);
    const base = `http://localhost/v1/couples/${c1}/mornings/slots/${scope.slotId}/discussion-v2`;
    const request = (suffix = '/' + f.messageId, method = 'PATCH', body: unknown = { membership_epoch: 1, command_id: id(8100), expected_version: 1, body: 'Changed' }, headers: Record<string, string> = {}) => new Request(base + suffix, { method, headers: { 'content-type': 'application/json', 'idempotency-key': id(8100), ...headers }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(200);
    const deleted = await handler(request('/' + f.messageId, 'DELETE', { membership_epoch: 1, command_id: id(8101), expected_version: 2, confirm: true }, { 'idempotency-key': id(8101) }));
    expect(deleted.status).toBe(200);
    const terminal = await handler(request('/' + f.messageId, 'DELETE', { membership_epoch: 1, command_id: id(8102), expected_version: 3, confirm: true }, { 'idempotency-key': id(8102) }));
    expect(terminal.status).toBe(409);
    expect(await terminal.json()).toMatchObject({ ok: false, error: 'message_deleted', value: { commandId: id(8102), message: { body: null } } });
    expect((await handler(request(`?membership_epoch=1&read_id=${id(8103)}&direction=first`, 'GET'))).status).toBe(200);
    expect((await handler(request('', 'POST', { membership_epoch: 1, command_id: original.commandId, body: original.body }, { 'idempotency-key': original.commandId }))).status).toBe(200);
    for (const body of ['{', 'null', '{}', { membership_epoch: 1, command_id: id(8104), expected_version: 1, body: 'Changed' }])
        expect((await handler(request(undefined, 'PATCH', body))).status).toBe(400);
    expect((await handler(request('/' + f.messageId + '?x=1'))).status).toBe(400);
    expect((await handler(request(undefined, 'PATCH', undefined, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await handler(request(undefined, 'PUT'))).status).toBe(405);
    expect((await handler(new Request(base + '/x/extra'))).status).toBe(404);
    f.flags.principal = null;
    expect((await handler(request())).status).toBe(401);
    f.flags.principal = identityPrincipal(u2);
    expect((await handler(request())).status).toBe(403);
    f.flags.principal = principal;
    f.flags.failSql = 'FROM couples';
    expect((await handler(request())).status).toBe(503);
});
it('canonical target reload reaches offwindow identity and tombstone without broadening scope', async () => {
    const f = await seed(), handler = createMorningDiscussionV2Handler(f.db);
    const base = `http://localhost/v1/couples/${c1}/mornings/slots/${scope.slotId}/discussion-v2/`;
    const req = (messageId = f.messageId, query = `membership_epoch=1&read_id=${id(8200)}`) => new Request(base + messageId + '?' + query);
    expect(await (await handler(req())).json()).toMatchObject({ ok: true, value: { readId: id(8200), message: { id: f.messageId, version: 1 } } });
    expect((await handler(req(id(9999)))).status).toBe(403);
    for (const q of ['', `membership_epoch=1&read_id=${id(8200)}&extra=1`, 'membership_epoch=1&read_id=bad'])
        expect((await handler(req(undefined, q))).status).toBe(400);
    expect((await handler(req(undefined, `membership_epoch=2&read_id=${id(8200)}`))).status).toBe(409);
    expect((await handler(req('bad'))).status).toBe(400);
    await mutateMorningDiscussion(f.db, principal, del(f.messageId), 'delete');
    expect(await (await handler(req())).json()).toMatchObject({ ok: true, value: { message: { id: f.messageId, body: null, version: 2, editedAt: null } } });
});
