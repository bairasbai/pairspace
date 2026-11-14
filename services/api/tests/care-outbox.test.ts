import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { simulateCareOutbox as run } from '../src/care-outbox.ts';
import { sendCareSignal } from '../src/care-signals.ts';
import { saveNotificationPreferences as save } from '../src/notification-preferences.ts';
import { closeCouple } from '../src/chat.ts';
import { adapter,c1,c2,createFixture,id,identityPrincipal,principal,u2,u3,failOn } from './fixtures.ts';
let pg:PGlite, clock=new Date('2026-11-10T00:00:00Z'), seq=820;
const db=()=>({...adapter(pg),now:()=>clock});
const scope={coupleId:c1,membershipEpoch:1};
async function event(pair=c1,who=principal){
 clock=new Date(clock.getTime()+61000);
 const sent=await sendCareSignal(db(),who,{coupleId:pair,membershipEpoch:1,clientId:id(seq++)});
 expect(sent.ok).toBe(true);
 const rows=await pg.query<{id:string}>('SELECT id FROM outbox_events WHERE care_signal_id=$1',[sent.ok?sent.value.signal.id:null]);
 return rows.rows[0].id;
}
beforeAll(async()=>{pg=await createFixture();for(const f of ['005_care_signals.sql','012_shared_dates.sql','032_notification_preferences.sql','033_care_notification_simulations.sql'])await pg.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));});
afterAll(async()=>{await pg.close();});
it('captures new events only and retries immutable observations without leaking prefs in send',async()=>{
 const cmd={...scope,clientId:id(seq++)};
 const sent=await sendCareSignal(db(),principal,cmd);expect(sent.ok).toBe(true);
 expect(Object.keys(sent.ok?sent.value:{}).sort()).toEqual(['replay','signal']);
 const e=(await pg.query<{id:string}>('SELECT id FROM outbox_events')).rows[0].id;
 expect((await sendCareSignal(db(),principal,cmd))).toMatchObject({ok:true,value:{replay:true}});
 expect((await pg.query('SELECT id FROM outbox_events')).rows).toHaveLength(1);
 const first=await run(db(),e);expect(first).toMatchObject({ok:true,value:{reason:'disabled',preferenceVersion:0,replay:false,historicalObservation:true,simulationOnly:true}});
 expect(await save(db(),identityPrincipal(u2),{...scope,commandId:id(seq++),expectedVersion:0,care:true,chat:false,letter:false,quiet:null})).toMatchObject({ok:true});
 expect(await run(db(),e)).toEqual(first.ok?{ok:true,value:{...first.value,replay:true}}:null);
 const fresh=await event();expect(await run(db(),fresh)).toMatchObject({ok:true,value:{reason:'allowed',state:'simulation_eligible',preferenceVersion:1}});
 const other=await event(c2,identityPrincipal(u3));expect(await run(db(),other)).toMatchObject({ok:true,value:{coupleId:c2,reason:'disabled'}});
});
it('quiet hours use latest recipient policy and immutable completed observation',async()=>{
 expect(await save(db(),identityPrincipal(u2),{...scope,commandId:id(seq++),expectedVersion:1,care:true,chat:false,letter:false,quiet:{start:'00:00',end:'23:59',timezone:'UTC'}})).toMatchObject({ok:true});
 const e=await event();expect(await run(db(),e)).toMatchObject({ok:true,value:{reason:'quiet_hours',preferenceVersion:2}});
 expect(await save(db(),identityPrincipal(u2),{...scope,commandId:id(seq++),expectedVersion:2,care:true,chat:false,letter:false,quiet:null})).toMatchObject({ok:true});
 expect(await run(db(),e)).toMatchObject({ok:true,value:{reason:'quiet_hours',preferenceVersion:2,replay:true}});
 expect(await run(db(),await event())).toMatchObject({ok:true,value:{reason:'allowed',preferenceVersion:3}});
});
it('clock and freshness are fail closed; invalid and unsupported IDs do not create observations',async()=>{
 expect(await run(db(),'bad')).toEqual({ok:false,error:'invalid_request'});
 expect(await run(db(),id(9999))).toEqual({ok:false,error:'not_found'});
 const e=await event();const original=clock;
 await expect(run({...db(),now:()=>new Date(NaN)},e)).rejects.toThrow('invalid_server_clock');
 clock=new Date(original.getTime()-1);expect(await run(db(),e)).toMatchObject({ok:true,value:{reason:'unavailable',preferenceVersion:null}});
 clock=original;const old=await event();clock=new Date(clock.getTime()+86400000);
 expect(await run(db(),old)).toMatchObject({ok:true,value:{reason:'expired',preferenceVersion:null}});
});
it('transaction errors leave pending outbox, retry succeeds and privacy leave does not rewrite history',async()=>{
 const e=await event();await expect(run(failOn(db(),'UPDATE outbox_events'),e)).rejects.toThrow('simulated_failure');
 expect((await pg.query('SELECT id FROM care_notification_simulations WHERE event_id=$1',[e])).rows).toHaveLength(0);
 expect((await pg.query<{processed_at:null}>('SELECT processed_at FROM outbox_events WHERE id=$1',[e])).rows[0].processed_at).toBeNull();
 const first=await run(db(),e);expect(first).toMatchObject({ok:true,value:{reason:'allowed'}});
 const pending=await event();await closeCouple(db(),principal,c1,1);
 expect(await run(db(),pending)).toMatchObject({ok:true,value:{reason:'unavailable',preferenceVersion:null}});
 expect(await run(db(),e)).toEqual(first.ok?{ok:true,value:{...first.value,replay:true}}:null);
 const close=(await pg.query<{id:string}>("SELECT id FROM outbox_events WHERE type='couple.closed'")).rows[0].id;
 expect(await run(db(),close)).toEqual({ok:false,error:'not_found'});
 await expect(pg.query('DELETE FROM care_notification_simulations')).rejects.toThrow();
 await expect(pg.query("UPDATE care_notification_simulations SET reason='disabled'")).rejects.toThrow();
});
it('internal canonical checks reject malformed scope before private preference reads',async()=>{
 for(const change of [{source_epoch:9},{kind:'other'},{sender_id:u2},{created_at:'bad'},{}]){
  const mock={now:()=>new Date('2026-11-10T00:00:00Z'),transaction:async<T>(work:(tx:import('../src/contracts.ts').SqlExecutor)=>Promise<T>)=>work({
   query:async<T>(sql:string)=>{
    let rows:unknown[]=[];
    if(sql.startsWith('SELECT couple_id FROM outbox'))rows=[{couple_id:c1}];
    else if(sql.startsWith('SELECT status'))rows=[{status:'active',membership_epoch:1}];
    else if(sql.includes('JOIN care_signals'))rows=[{couple_id:c1,care_signal_id:id(42),membership_epoch:1,source_epoch:1,sender_id:principal.userId,recipient_id:u2,kind:'thinking_of_you',created_at:'2026-11-10T00:00:00Z',...change}];
    else if(sql.includes('FROM couple_members'))rows=Object.keys(change).length?[{user_id:principal.userId},{user_id:u2}]:[];
    else if(sql.includes('FROM notification_preferences'))throw Error('must_not_read_private_preferences');
    else if(sql.startsWith('INSERT INTO care_notification'))rows=[{id:id(43),event_id:id(44),couple_id:c1,recipient_id:u2,membership_epoch:1,state:'simulation_blocked',reason:'unavailable',evaluated_at:'2026-11-10T00:00:00Z',preference_version:null}];
    return {rows:rows as T[]};
   }
  })};
  expect(await run(mock,id(44))).toMatchObject({ok:true,value:{reason:'unavailable'}});
 }
});
