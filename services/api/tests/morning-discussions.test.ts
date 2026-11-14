import { it, expect } from 'vitest';
import { sendMorningDiscussion, readMorningDiscussion } from '../src/morning-discussions.ts';
import { createMorningDiscussionsHandler } from '../src/morning-discussions-http.ts';
import { discussionFixture } from './morning-discussions.fixture.ts';
import { principal, identityPrincipal, u2, u3, c1, c2, id } from './fixtures.ts';
const scope = { coupleId: c1, membershipEpoch: 1, slotId: id(9000) };
const send = (n = 1) => ({ ...scope, commandId: id(9100 + n), body: ' One\r\n🙂 ' });
const read = () => ({ ...scope, readId: id(9200), direction: 'first' });
it('immutable authorship, normalized multiline reply, exact retry and rollback without duplicated message', async () => {
    const f = discussionFixture();
    const first = await sendMorningDiscussion(f.db, principal, send());
    expect(first).toMatchObject({ ok: true, value: { replay: false, message: { authorId: principal.userId, body: ' One\n🙂 ', slotId: scope.slotId, seq: 3 } } });
    expect(await sendMorningDiscussion(f.db, principal, send())).toMatchObject({ ok: true, value: { replay: true, message: first.ok ? first.value.message : {} } });
    expect(await sendMorningDiscussion(f.db, principal, { ...send(), body: 'Changed' })).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(await sendMorningDiscussion(f.db, identityPrincipal(u2), send())).toMatchObject({ ok: true, value: { message: { authorId: u2, seq: 6 } } });
    f.flags.failReceipt = true;
    await expect(sendMorningDiscussion(f.db, principal, send(2))).rejects.toThrow('synthetic_receipt_failure');
    expect(f.rows).toHaveLength(2);
    expect(f.receipts).toHaveLength(2);
    f.flags.failReceipt = false;
    f.flags.allowed = false;
    f.queries.length = 0;
    expect(await sendMorningDiscussion(f.db, principal, send())).toEqual({ ok: false, error: 'unavailable' });
    expect(f.queries.some(q => q.includes('morning_discussion_'))).toBe(false);
    f.flags.allowed = true;
    f.flags.missingReplay = true;
    await expect(sendMorningDiscussion(f.db, principal, send())).rejects.toThrow('morning_discussion_receipt_invariant');
});
it('bounded native sequence windows support all navigation and scoped id+seq anchors with gaps', async () => {
    const f = discussionFixture();
    expect(await readMorningDiscussion(f.db, principal, read())).toMatchObject({ ok: true, value: { messages: [], hasPrevious: false, hasNext: false, previousCursor: null, nextCursor: null } });
    for (let n = 0; n < 65; n++)
        expect((await sendMorningDiscussion(f.db, n % 2 ? identityPrincipal(u2) : principal, send(n))).ok).toBe(true);
    const page = await readMorningDiscussion(f.db, principal, read());
    if (!page.ok)
        throw Error('page');
    expect(page.value.messages.map(m => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => (i + 1) * 3));
    const second = await readMorningDiscussion(f.db, principal, { ...read(), direction: 'after', anchorId: page.value.nextCursor!.id, anchorSeq: page.value.nextCursor!.seq });
    if (!second.ok)
        throw Error('page');
    expect(second.value.messages).toHaveLength(30);
    expect(second.value.hasPrevious).toBe(true);
    expect(second.value.hasNext).toBe(true);
    const prev = second.value.previousCursor!;
    expect(await readMorningDiscussion(f.db, principal, { ...read(), direction: 'before', anchorId: prev.id, anchorSeq: prev.seq })).toMatchObject({ ok: true, value: { messages: page.value.messages } });
    const last = await readMorningDiscussion(f.db, principal, { ...read(), direction: 'last' });
    if (!last.ok)
        throw Error('page');
    expect(last.value.messages.at(-1)?.seq).toBe(195);
    expect(last.value.hasNext).toBe(false);
    expect(await readMorningDiscussion(f.db, principal, { ...read(), direction: 'after', anchorId: id(9999), anchorSeq: 3 })).toEqual({ ok: false, error: 'invalid_cursor' });
});
it('shape, bounds, ownership, epoch and post-last-lock authority fail closed', async () => {
    const f = discussionFixture();
    for (const v of [null, [], {}, { ...send(), authorId: u2 }, { ...send(), slotId: 'bad' }, { ...send(), body: ' ' }, { ...send(), body: '🙂'.repeat(8001) }])
        expect(await sendMorningDiscussion(f.db, principal, v)).toEqual({ ok: false, error: 'invalid_request' });
    for (const v of [null, {}, { ...read(), direction: 'latest' }, { ...read(), readId: 'bad' }])
        expect(await readMorningDiscussion(f.db, principal, v)).toEqual({ ok: false, error: 'invalid_request' });
    for (const v of [-1, 0, '3', 1.2, Number.MAX_SAFE_INTEGER + 1])
        expect(await readMorningDiscussion(f.db, principal, { ...read(), direction: 'after', anchorId: id(1), anchorSeq: v })).toEqual({ ok: false, error: 'invalid_cursor' });
    expect(await readMorningDiscussion(f.db, identityPrincipal(u3), read())).toEqual({ ok: false, error: 'unavailable' });
    expect(await readMorningDiscussion(f.db, principal, { ...read(), coupleId: c2 })).toEqual({ ok: false, error: 'unavailable' });
    expect(await readMorningDiscussion(f.db, principal, { ...read(), membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    const expired = discussionFixture();
    expired.flags.denyCheck = 3;
    expect(await sendMorningDiscussion(expired.db, principal, send())).toEqual({ ok: false, error: 'unavailable' });
    expect(expired.queries.some(q => q.includes('morning_discussion_'))).toBe(false);
});
it('strict GET/POST protocol, nonce, generic access errors, duplicate query rejection and provider failures', async () => {
    const f = discussionFixture(), handler = createMorningDiscussionsHandler(f.db);
    const base = `http://localhost/v1/couples/${c1}/mornings/slots/${scope.slotId}/discussion`;
    const query = `?membership_epoch=1&read_id=${id(9200)}&direction=first`;
    const req = (suffix = query, method = 'GET', body?: string, headers: Record<string, string> = {}) => new Request(base + suffix, { method, headers: { 'content-type': 'application/json', 'idempotency-key': id(9101), ...headers }, ...(body ? { body } : {}) });
    expect((await handler(req())).status).toBe(200);
    const body = JSON.stringify({ membership_epoch: 1, command_id: id(9101), body: 'One' });
    expect((await handler(req('', 'POST', body))).status).toBe(200);
    expect((await handler(req('', 'POST', body.replace('One', 'Changed')))).status).toBe(409);
    for (const q of ['', query + '&extra=1', query + '&read_id=' + id(9200), query.replace('first', 'after') + '&anchor_id=' + id(1) + '&anchor_seq=no', query.replace('first', 'after') + '&anchor_id=' + id(1) + '&anchor_seq=3'])
        expect((await handler(req(q))).status).toBe(400);
    for (const raw of ['{', 'null', '{}', body.replace(id(9101), id(9102))])
        expect((await handler(req('', 'POST', raw))).status).toBe(400);
    expect((await handler(req('?x=1', 'POST', body))).status).toBe(400);
    expect((await handler(req('', 'POST', body, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await handler(req('', 'PUT', body))).status).toBe(405);
    expect((await handler(new Request(base + '/extra'))).status).toBe(404);
    expect((await handler(req(query.replace('epoch=1', 'epoch=2')))).status).toBe(409);
    f.flags.allowed = false;
    expect((await handler(req())).status).toBe(403);
    expect((await handler(req('', 'POST', body))).status).toBe(403);
    f.flags.principal = null;
    expect((await handler(req())).status).toBe(401);
    f.flags.principal = principal;
    f.flags.failSql = 'FROM couples';
    expect(await (await handler(req())).json()).toMatchObject({ error: 'temporarily_unavailable', readId: id(9200) });
});
