import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, c2, id, failOn } from './fixtures.ts';
import { sendMessage, readHistory } from '../src/chat.ts';
import { sendChatReply, readChatMessage } from '../src/chat-replies.ts';
import { readChatWindow } from '../src/chat-history-window.ts';
import { setChatVisibility, readChatVisibility } from '../src/chat-visibility.ts';
import { readHiddenWindow } from '../src/chat-hidden-window.ts';
import { visibilityResponse, rememberChatScope, visibleChatPredicate, hiddenChatReplay, chatVisibilityRevision } from '../src/chat-visibility-scope.ts';
import { createChatVisibilityHandler } from '../src/chat-visibility-http.ts';
import { createChatRepliesHandler } from '../src/chat-replies-http.ts';
import { createChatEditingHandler } from '../src/chat-editing-http.ts';
import { createChatDeletionHandler } from '../src/chat-deletion-http.ts';
import { createChatHandler } from '../src/http.ts';
import { editChatMessage } from '../src/chat-editing.ts';
import { deleteChatMessage } from '../src/chat-deletion.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
let pg: PGlite, root: string, replyId: string;
const scope = { coupleId: c1, membershipEpoch: 1 };
const plain = { ...scope, clientId: id(8000), body: 'Original private text' };
const detail = (messageId = root) => ({ ...scope, messageId, readId: id(8001) });
const change = (hidden: boolean, expectedVersion: number, commandId = id(8002), messageId = root) => ({ ...scope, messageId, commandId, expectedVersion, hidden });
const window = (direction = 'latest') => ({ ...scope, readId: id(8003), direction });
const read = async () => readChatVisibility(adapter(pg), principal, detail());
function bound(p = principal) { return bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => p)); }
function request(path: string, method = 'GET', body?: unknown, opted = true) {
    return new Request(`http://localhost/v1/couples/${c1}/chat/${path}`, {
        method, headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', ...(opted ? { 'X-Chat-Visibility': '1' } : {}),
            ...(body && typeof body === 'object' && 'command_id' in body ? { 'idempotency-key': String(body.command_id) } : {}),
            ...(body && typeof body === 'object' && 'client_message_id' in body ? { 'idempotency-key': String(body.client_message_id) } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
}
beforeAll(async () => {
    pg = await createFixture();
    for (const file of ['020_chat_replies.sql', '021_chat_deletion_receipts.sql', '022_chat_message_edits.sql', '023_chat_personal_visibility.sql'])
        await pg.transaction(async (tx) => { await tx.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')); });
    const a = await sendMessage(adapter(pg), principal, plain);
    if (!a.ok)
        throw Error('seed');
    root = a.value.message.id;
    const b = await sendChatReply(adapter(pg), identityPrincipal(u2), { ...scope, clientId: id(8004), body: 'Reply', replyToId: root });
    if (!b.ok)
        throw Error('seed');
    replyId = b.value.message.id;
});
afterAll(async () => { await pg.close(); });
it('hides only actor scope, atomically increments revisions, noops/replays do not toggle; all histories filter', async () => {
    expect(await read()).toMatchObject({ ok: true, value: { visibility: { hidden: false, version: 0 } } });
    await expect(setChatVisibility(failOn(adapter(pg), 'INSERT INTO chat_visibility_receipts'), principal, change(true, 0))).rejects.toThrow('simulated_failure');
    expect(await read()).toMatchObject({ value: { visibility: { hidden: false, version: 0 } } });
    expect((await pg.query('SELECT * FROM chat_visibility_scopes')).rows).toHaveLength(0);
    expect(await setChatVisibility(adapter(pg), principal, change(true, 0))).toMatchObject({ ok: true, value: { replay: false, visibility: { hidden: true, version: 1 } } });
    expect(await setChatVisibility(adapter(pg), principal, change(true, 0))).toMatchObject({ value: { replay: true, visibility: { version: 1 } } });
    expect(await setChatVisibility(adapter(pg), principal, change(true, 1, id(8010)))).toMatchObject({ value: { visibility: { version: 1 } } });
    expect(await setChatVisibility(adapter(pg), principal, change(false, 0, id(8011)))).toEqual({ ok: false, error: 'version_conflict' });
    expect(await setChatVisibility(adapter(pg), principal, change(false, 1))).toEqual({ ok: false, error: 'idempotency_conflict' });
    for (const result of [await readHistory(adapter(pg), principal, { ...scope, limit: 50 }), await readChatWindow(adapter(pg), principal, window()), await readChatWindow(adapter(pg), principal, window(), true)]) {
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.value.messages.map(m => m.id)).toEqual([replyId]);
    }
    expect(await readChatMessage(adapter(pg), principal, detail())).toEqual({ ok: false, error: 'message_hidden' });
    expect(await readChatMessage(adapter(pg), identityPrincipal(u2), detail())).toMatchObject({ ok: true, value: { message: { body: plain.body } } });
    expect(await readChatWindow(adapter(pg), principal, { ...window('after'), anchorId: root, anchorSeq: 1 }, true)).toEqual({ ok: false, error: 'invalid_cursor' });
    expect(await sendChatReply(adapter(pg), principal, { ...scope, clientId: id(8012), body: 'No', replyToId: root })).toEqual({ ok: false, error: 'message_hidden' });
    expect((await pg.query('SELECT revision::text FROM chat_visibility_scopes')).rows).toEqual([{ revision: '1' }]);
    expect((await pg.query('SELECT count(*)::int n FROM outbox_events')).rows[0]).toEqual({ n: 2 });
});
it('hidden committed create/edit/delete receipts are explicit metadata-only opt-in successes, conflicts stay conflicts', async () => {
    const send = visibilityResponse(bound(), createChatHandler);
    const payload = { membership_epoch: 1, client_message_id: plain.clientId, body: plain.body };
    const response = await send(request('messages', 'POST', payload));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Chat-Visibility-Revision')).toBe('1');
    expect(await response.json()).toMatchObject({ ok: true, value: { replay: true, hiddenMessage: { id: root, version: 1 } } });
    expect(JSON.stringify(await (await send(request('messages', 'POST', payload))).json())).not.toContain(plain.body);
    expect((await send(request('messages', 'POST', payload, false))).status).toBe(403);
    expect((await send(request('messages', 'POST', { ...payload, body: 'changed' }))).status).toBe(409);
    await setChatVisibility(adapter(pg), principal, change(false, 1, id(8020)));
    const edit = { ...scope, messageId: root, commandId: id(8021), expectedVersion: 1, body: 'Edited' };
    expect(await editChatMessage(adapter(pg), principal, edit)).toMatchObject({ ok: true });
    await setChatVisibility(adapter(pg), principal, change(true, 2, id(8022)));
    const patch = visibilityResponse(bound(), createChatEditingHandler);
    const wire = { membership_epoch: 1, command_id: edit.commandId, expected_version: 1, body: edit.body };
    expect(await (await patch(request(`messages/${root}`, 'PATCH', wire))).json()).toMatchObject({ ok: true, value: { commandId: edit.commandId, replay: true, hiddenMessage: { id: root, version: 2 } } });
    expect(await editChatMessage(adapter(pg), principal, { ...edit, commandId: id(8023), expectedVersion: 2 })).toEqual({ ok: false, error: 'message_hidden' });
    await setChatVisibility(adapter(pg), principal, change(false, 3, id(8024)));
    const remove = { ...scope, messageId: root, commandId: id(8025), expectedVersion: 2, scope: 'everyone' };
    expect(await deleteChatMessage(adapter(pg), principal, remove)).toMatchObject({ ok: true });
    await setChatVisibility(adapter(pg), principal, change(true, 4, id(8026)));
    const deletion = visibilityResponse(bound(), createChatDeletionHandler);
    expect(await (await deletion(request(`messages/${root}`, 'DELETE', { membership_epoch: 1, command_id: remove.commandId, expected_version: 2, scope: 'everyone' }))).json()).toMatchObject({ ok: true, value: { hiddenMessage: { id: root, version: 3 }, replay: true } });
    const hidden = await readHiddenWindow(adapter(pg), principal, window());
    expect(hidden).toMatchObject({ ok: true, value: { messages: [{ id: root, version: 3, visibilityVersion: 5 }] } });
    if (hidden.ok) {
        expect(hidden.value.messages[0].deletedAt).not.toBeNull();
        expect(hidden.value.messages[0]).not.toHaveProperty('body');
    }
    await setChatVisibility(adapter(pg), principal, change(false, 5, id(8027)));
    expect(await readChatMessage(adapter(pg), principal, detail())).toMatchObject({ value: { message: { body: null, version: 3 } } });
});
it('strict HTTP metadata and local errors echo nonce/revision without partner visibility leakage', async () => {
    const handler = visibilityResponse(bound(), createChatVisibilityHandler);
    const path = `messages/${replyId}/visibility?membership_epoch=1&read_id=${id(8030)}`;
    expect(await (await handler(request(path))).json()).toMatchObject({ ok: true, value: { visibility: { messageId: replyId, hidden: false, version: 0 }, readId: id(8030) } });
    const wire = { membership_epoch: 1, command_id: id(8031), expected_visibility_version: 0, hidden: true };
    const saved = await handler(request(`messages/${replyId}/hidden`, 'PUT', wire));
    expect(saved.status).toBe(200);
    const revision = Number(saved.headers.get('X-Chat-Visibility-Revision'));
    expect(revision).toBe(7);
    expect((await handler(request(`hidden-window?membership_epoch=1&read_id=${id(8030)}&direction=after&anchor_id=${replyId}&anchor_seq=2&visibility_revision=0`))).status).toBe(409);
    const bad = await handler(request(`messages/${id(9999)}/visibility?membership_epoch=1&read_id=${id(8030)}`));
    expect(bad.status).toBe(409);
    expect(bad.headers.get('X-Chat-Visibility-Revision')).toBe('7');
    const partner = visibilityResponse(bound(identityPrincipal(u2)), createChatVisibilityHandler);
    expect((await partner(request(path))).headers.get('X-Chat-Visibility-Revision')).toBe('0');
    for (const [p, m, b] of [['missing', 'GET', undefined], [path, 'POST', {}], [`messages/${replyId}/hidden`, 'PUT', { ...wire, extra: 1 }], ['hidden-window?membership_epoch=0', 'GET', undefined]] as const)
        expect((await handler(request(p, m, b))).status).toBeGreaterThanOrEqual(400);
    expect(await setChatVisibility(adapter(pg), identityPrincipal(u3), change(true, 0, id(8033), replyId))).toEqual({ ok: false, error: 'unavailable' });
    expect(await setChatVisibility(adapter(pg), principal, { ...change(true, 0), coupleId: c2 })).toEqual({ ok: false, error: 'unavailable' });
    expect(await setChatVisibility(adapter(pg), principal, { ...change(true, 0), membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await setChatVisibility(adapter(pg), principal, { ...change(true, 0), hidden: 'yes' })).toEqual({ ok: false, error: 'invalid_request' });
    const reply = visibilityResponse(bound(), createChatRepliesHandler);
    const denied = await reply(request(`message-detail?membership_epoch=1&message_id=${replyId}&read_id=${id(8030)}`));
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: 'message_hidden', readId: id(8030) });
});
it('fails closed across malformed input, expired scope, post-lock recheck and strict HTTP perimeter',async()=>{
  const db=adapter(pg);
  for(const fn of [readChatVisibility,setChatVisibility,readHiddenWindow]){
    expect(await fn(db,principal,null)).toEqual({ok:false,error:'invalid_request'});
    expect(await fn(db,{...principal,userId:'bad'},{})).toEqual({ok:false,error:'unavailable'});
  }
  for(const f of [{...detail(),messageId:'bad'},{...detail(),extra:true}])expect(await readChatVisibility(db,principal,f)).toEqual({ok:false,error:'invalid_request'});
  expect(await setChatVisibility(db,principal,{...change(false,0),expectedVersion:-1})).toEqual({ok:false,error:'invalid_request'});
  expect(await readHiddenWindow(db,principal,{...window(),direction:'wrong'})).toEqual({ok:false,error:'invalid_request'});
  expect(await readHiddenWindow(db,principal,{...window('before'),anchorId:id(9),anchorSeq:0,visibilityRevision:0})).toEqual({ok:false,error:'invalid_cursor'});
  const expired={...principal,tokenExpiresAt:1};
  for(const [fn,input] of [[readChatVisibility,detail()],[setChatVisibility,change(false,1)],[readHiddenWindow,window()]] as const){
    expect(await fn(db,expired,input)).toEqual({ok:false,error:'unavailable'});
    let checks=0;
    const late={...db,sessionAuthority:{...db.sessionAuthority,recheck:async()=>++checks===1}};
    expect(await fn(late,principal,input)).toEqual({ok:false,error:'unavailable'});
  }
  expect(await readChatVisibility(db,identityPrincipal(u3),detail())).toEqual({ok:false,error:'unavailable'});
  expect(await readHiddenWindow(db,identityPrincipal(u3),window())).toEqual({ok:false,error:'unavailable'});
  expect(await setChatVisibility(db,principal,change(false,0,id(8041),id(9999)))).toEqual({ok:false,error:'message_unavailable'});
  const handler=visibilityResponse(bound(),createChatVisibilityHandler);
  const path=`messages/${root}/hidden`;
  const headers={authorization:'Bearer synthetic','X-Chat-Visibility':'1','content-type':'application/json'};
  for(const [body,extra] of [['[1]',{}],['{',{}],['null',{}],[JSON.stringify({membership_epoch:1,command_id:id(8040),expected_visibility_version:6,hidden:false}),{}]] as const){
    expect((await handler(new Request(`http://localhost/v1/couples/${c1}/chat/${path}`,{method:'PUT',headers:{...headers,...extra},body}))).status).toBe(400);
  }
  expect((await handler(new Request(`http://localhost/v1/couples/${c1}/chat/${path}`,{method:'PUT',headers:{authorization:'Bearer synthetic','content-type':'text/plain'},body:'x'}))).status).toBe(415);
  expect((await handler(request(path+'?extra=1','PUT',{}))).status).toBe(400);
  expect((await handler(new Request(`http://localhost/v1/couples/${c1}/chat/hidden-window?membership_epoch=1&read_id=${id(8042)}&direction=latest`))).status).toBe(401);
  const broken=visibilityResponse(failOn(bound(),'SELECT status'),createChatVisibilityHandler);
  expect((await broken(request(`messages/${root}/visibility?membership_epoch=1&read_id=${id(8042)}`))).status).toBe(503);
  expect((await handler(request(`hidden-window?membership_epoch=1&read_id=${id(8042)}&direction=before&anchor_id=${replyId}&anchor_seq=2&visibility_revision=x`))).status).toBe(400);
  const plain=visibilityResponse(bound(),()=>async()=>new Response('non-json'));
  expect(await (await plain(request('messages'))).text()).toBe('non-json');
});
it('hidden pagination covers all 61 rows and both directions; metadata-only reply replay binds original body and parent',async()=>{
  const db=adapter(pg);
  const ids=Array.from({length:60},(_,i)=>id(9000+i));
  await pg.query(`INSERT INTO chat_messages(id,couple_id,sender_id,client_message_id,seq,body)
    SELECT value::uuid,$1,$2,value::uuid,1000+ordinality,'Synthetic bulk' FROM unnest($3::text[]) WITH ORDINALITY AS x(value,ordinality)`,[c1,principal.userId,ids]);
  for(const messageId of ids)expect((await setChatVisibility(db,principal,change(true,0,id(10000+ids.indexOf(messageId)),messageId))).ok).toBe(true);
  const latest=await readHiddenWindow(db,principal,window());
  if(!latest.ok)throw Error('page');
  expect(latest.value.messages).toHaveLength(50);expect(latest.value.hasOlder).toBe(true);
  const revision=67,cursor=latest.value.olderCursor!;
  const older=await readHiddenWindow(db,principal,{...window('before'),anchorId:cursor.id,anchorSeq:cursor.seq,visibilityRevision:revision});
  if(!older.ok)throw Error('older');
  expect(older.value.messages).toHaveLength(11);expect(older.value.hasNewer).toBe(true);
  const next=older.value.newerCursor!;
  expect(await readHiddenWindow(db,principal,{...window('after'),anchorId:next.id,anchorSeq:next.seq,visibilityRevision:revision})).toMatchObject({ok:true,value:{hasOlder:true,hasNewer:false}});
  expect(await readHiddenWindow(db,principal,{...window('before'),anchorId:id(999),anchorSeq:1,visibilityRevision:revision})).toEqual({ok:false,error:'invalid_cursor'});
  expect(await readHiddenWindow(db,identityPrincipal(u2),window('oldest'))).toMatchObject({ok:true,value:{messages:[],hasOlder:false,hasNewer:false}});
  const handler=visibilityResponse(bound(),createChatVisibilityHandler);
  expect((await handler(request(`hidden-window?membership_epoch=1&read_id=${id(8042)}&direction=latest`))).status).toBe(200);
  await setChatVisibility(db,identityPrincipal(u2),change(true,0,id(8050),replyId));
  const reply=visibilityResponse(bound(identityPrincipal(u2)),createChatRepliesHandler);
  const wire={membership_epoch:1,client_message_id:id(8004),body:'Reply',reply_to_id:root};
  expect(await (await reply(request('replies','POST',wire))).json()).toMatchObject({ok:true,value:{replay:true,hiddenMessage:{id:replyId,replyToId:root}}});
  expect((await reply(request('replies','POST',{...wire,body:'Changed'}))).status).toBe(409);
  expect((await reply(request('replies','POST',wire,false))).status).toBe(409);
});
it('guards trusted scope interpolation, absent replay records and unsafe revision overflow',async()=>{
  await adapter(pg).transaction(async tx=>{
    expect(()=>rememberChatScope(tx,{...principal,userId:'bad'},c1,1)).toThrow('invalid_visibility_scope');
    expect(await chatVisibilityRevision(tx)).toBeUndefined();
    await expect(hiddenChatReplay(tx,root)).rejects.toThrow('missing_visibility_scope');
    rememberChatScope(tx,principal,c1,1);
    await expect(visibleChatPredicate(tx,'m;DROP')).rejects.toThrow('invalid_visibility_alias');
    await expect(hiddenChatReplay(tx,id(999999))).rejects.toThrow('missing_hidden_replay');
    const overflow={query:async<T>(sql:string,params?:unknown[])=>sql.includes('revision::text')
      ?{rows:[{revision:'9007199254740992'}] as T[]}:tx.query<T>(sql,params)};
    rememberChatScope(overflow,principal,c1,1);
    await expect(chatVisibilityRevision(overflow)).rejects.toThrow('visibility_revision_overflow');
  });
});
