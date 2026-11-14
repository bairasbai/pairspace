import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, id, failOn } from './fixtures.ts';
import { commandMorning } from '../src/morning-commands.ts';
import { draftMorningV2 } from '../src/morning-draft-v2.ts';
import { draftMorning } from '../src/morning-draft.ts';
import { readMorning } from '../src/morning-read.ts';
import { createMorningsHandler } from '../src/morning-http.ts';
let pg: PGlite, slotId: string;
const now = new Date(), scope = { coupleId: c1, membershipEpoch: 1 }, partner = identityPrincipal(u2);
const db = () => ({ ...adapter(pg), now: () => now });
const read = () => ({ ...scope, slotId, readId: id(9100) });
const edit = (n = 9101, body = 'Edited', expectedVersion = 1) => ({ ...scope, slotId, commandId: id(n), body, expectedVersion });
beforeAll(async () => {
    pg = await createFixture();
    for (const name of ['024_morning_ritual.sql', '028_morning_private_drafts.sql', '029_morning_draft_removal.sql'])
        await pg.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    await commandMorning(db(), partner, { ...scope, commandId: id(9000), expectedVersion: 0, timezone: 'UTC', localTime: '09:00' }, 'preference');
    const result = await commandMorning(db(), principal, { ...scope, commandId: id(9001), preferenceVersion: 1, localDate: new Date(now.getTime() + 5 * 86400000).toISOString().slice(0, 10), offset: '+00:00' }, 'schedule');
    if (!result.ok || !('slot' in result.value))
        throw Error('seed');
    slotId = result.value.slot.id;
});
afterAll(async () => pg.close());
it('v2 terminal removal keeps canonical retries and legacy fail-closed', async () => {
    expect(await draftMorningV2(db(), principal, read(), 'read')).toMatchObject({ value: { state: 'missing', body: null, version: 0 } });
    expect(await draftMorningV2(db(), principal, { ...read(), readId: undefined }, 'read')).toMatchObject({ error: 'invalid_request' });
    const removal = { ...scope, slotId, commandId: id(9801), expectedVersion: 1, confirm: true };
    expect(await draftMorningV2(db(), principal, removal, 'delete')).toMatchObject({ error: 'draft_missing' });
    const create = edit(9800, 'private', 0);
    expect(await draftMorningV2(db(), principal, create, 'save')).toMatchObject({ value: { state: 'live', version: 1 } });
    expect(await draftMorningV2(db(), principal, edit(9802, 'private', 1), 'save')).toMatchObject({ value: { version: 1 } });
    expect(await draftMorningV2(db(), principal, edit(9803, 'new', 1), 'save')).toMatchObject({ value: { version: 2 } });
    expect(await draftMorningV2(db(), principal, removal, 'delete')).toMatchObject({ error: 'version_conflict' });
    removal.expectedVersion = 2;
    const sealed = await readMorning(db(), partner, read());
    await expect(draftMorningV2(failOn(db(), 'INSERT INTO morning_draft_delete_receipts'), principal, removal, 'delete')).rejects.toThrow();
    expect(await draftMorningV2(db(), principal, read(), 'read')).toMatchObject({ value: { state: 'live', body: 'new', version: 2 } });
    expect(await draftMorningV2(db(), principal, removal, 'delete')).toMatchObject({ value: { state: 'deleted', body: null, version: 3, replay: false } });
    expect(await draftMorningV2(db(), principal, removal, 'delete')).toMatchObject({ value: { state: 'deleted', body: null, version: 3, replay: true } });
    expect(await draftMorningV2(db(), principal, create, 'save')).toMatchObject({ value: { state: 'deleted', body: null, version: 3, replay: true } });
    expect(await draftMorningV2(db(), principal, { ...removal, expectedVersion: 1 }, 'delete')).toMatchObject({ error: 'idempotency_conflict' });
    for (const operation of ['save','delete'] as const) {
        const input = operation === 'save' ? edit(9804, 'revive', 3) : { ...removal, commandId: id(9804), expectedVersion: 3 };
        expect(await draftMorningV2(db(), principal, input, operation)).toMatchObject({ ok: false, error: 'draft_deleted', value: { body: null, state: 'deleted', version: 3, replay: false } });
    }
    expect(await draftMorning(db(), principal, read(), false)).toEqual({ ok: false, error: 'draft_deleted' });
    expect(await draftMorning(db(), principal, create, true)).toEqual({ ok: false, error: 'draft_deleted' });
    expect(await readMorning(db(), partner, read())).toEqual(sealed);
    await commandMorning(db(), principal, { ...scope, slotId, commandId: id(9805), body: 'Separate canonical letter' }, 'fill');
    expect(await draftMorningV2(db(), principal, read(), 'read')).toMatchObject({ value: { state: 'deleted', version: 3 } });
});
it('v2 validation, recipient/foreign authorization and post-lock expiry', async () => {
    for (const actor of [partner, identityPrincipal(u3)]) expect(await draftMorningV2(db(), actor, read(), 'read')).toMatchObject({ error: 'unavailable' });
    for (const v of [null, {}, { ...edit(), expectedVersion: -1 }, { ...edit(), body: '' }])
        expect(await draftMorningV2(db(), principal, v, 'save')).toMatchObject({ error: 'invalid_request' });
    expect(await draftMorningV2(db(), principal, { ...scope, slotId, commandId: id(9830), expectedVersion: 1, confirm: false }, 'delete')).toMatchObject({ error: 'invalid_request' });
    expect(await draftMorningV2(db(), principal, { ...read(), slotId: id(99999) }, 'read')).toMatchObject({ error: 'unavailable' });
    let checks = 0;
    const revoked = { ...db(), sessionAuthority: { ...db().sessionAuthority, recheck: async () => ++checks < 3 } };
    expect(await draftMorningV2(revoked, principal, read(), 'read')).toMatchObject({ error: 'unavailable' });
    expect(await draftMorningV2(db(), principal, { ...read(), membershipEpoch: 2 }, 'read')).toMatchObject({ error: 'stale_membership' });
});
it('v2 wire tombstone errors carry canonical metadata; legacy carries no value', async () => {
    const d=db(),handler=createMorningsHandler({...d,sessionAuthority:{...d.sessionAuthority,authenticate:async()=>principal}});
    const base=`https://test/v1/couples/${c1}/mornings/slots/${slotId}/draft-v2`;
    const get=await handler(new Request(`${base}?membership_epoch=1&read_id=${id(9840)}`));
    expect(get.status).toBe(200);expect(await get.json()).toMatchObject({value:{state:'deleted',body:null}});
    for(const method of ['PUT','DELETE']) {
        const command=id(9841),raw={membership_epoch:1,command_id:command,expected_version:3,...(method==='DELETE'?{confirm:true}:{body:'revive'})};
        const r=await handler(new Request(base,{method,headers:{'content-type':'application/json','idempotency-key':command},body:JSON.stringify(raw)}));
        expect(r.status).toBe(409);expect(await r.json()).toMatchObject({ok:false,error:'draft_deleted',value:{state:'deleted',body:null,replay:false}});
    }
    const old=await handler(new Request(`${base.replace('draft-v2','draft')}?membership_epoch=1&read_id=${id(9842)}`));
    expect(old.status).toBe(409);expect(await old.json()).toEqual({ok:false,error:'draft_deleted',readId:id(9842)});
});
it('SQL tombstone is terminal, receipt history immutable', async () => {
    for(const sql of ["UPDATE morning_drafts SET body='revive',state='live',version=version+1",'DELETE FROM morning_drafts',
        'UPDATE morning_drafts SET version=version+1', 'DELETE FROM morning_draft_delete_receipts',"UPDATE morning_draft_delete_receipts SET fingerprint=repeat('f',64)"])
        await expect(pg.exec(sql)).rejects.toThrow();
    await expect(pg.query('INSERT INTO morning_draft_delete_receipts(actor_id,command_id,slot_id,fingerprint) VALUES($1,$2,$3,$4)',[u2,id(9850),slotId,'f'.repeat(64)])).rejects.toThrow();
});
it('migration preserves existing live draft and old receipt identity', async () => {
    const old = await createFixture();
    try {
        for (const name of ['024_morning_ritual.sql','028_morning_private_drafts.sql'])
            await old.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
        const database={...adapter(old),now:()=>now};
        await commandMorning(database,partner,{...scope,commandId:id(9900),expectedVersion:0,timezone:'UTC',localTime:'09:00'},'preference');
        const scheduled=await commandMorning(database,principal,{...scope,commandId:id(9901),preferenceVersion:1,
            localDate:new Date(now.getTime()+5*86400000).toISOString().slice(0,10),offset:'+00:00'},'schedule');
        if(!scheduled.ok||!('slot' in scheduled.value))throw Error('seed');
        const command={...scope,slotId:scheduled.value.slot.id,commandId:id(9902),expectedVersion:0,body:'Pre-migration private'};
        expect(await draftMorning(database,principal,command,true)).toMatchObject({value:{version:1}});
        const before=await old.query('SELECT * FROM morning_draft_receipts');
        await old.exec(await readFile(new URL('../migrations/029_morning_draft_removal.sql',import.meta.url),'utf8'));
        expect(await draftMorningV2(database,principal,command,'save')).toMatchObject({value:{state:'live',version:1,body:command.body,replay:true}});
        expect(await old.query('SELECT * FROM morning_draft_receipts')).toEqual(before);
    }finally{await old.close();}
});
