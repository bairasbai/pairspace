import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { sendCareSignal } from '../src/care-signals.ts';
import { adapter, c1, createFixture, id, principal, u1, u2 } from './fixtures.ts';
const migrate = async (pg: Awaited<ReturnType<typeof createFixture>>, name: string) => pg.exec(await readFile(new URL('../migrations/'+name, import.meta.url), 'utf8'));
it('capture rollback is atomic for signal/outbox failure and immutable command replay creates no duplicate', async () => {
 const pg=await createFixture();
 try {
  await migrate(pg,'005_care_signals.sql');await migrate(pg,'033_care_notification_simulations.sql');
  const db={...adapter(pg),now:()=>new Date('2026-11-10T00:00:00Z')};
  const command={coupleId:c1,membershipEpoch:1,clientId:id(991)};
  for(const prefix of ['INSERT INTO care_signals','INSERT INTO outbox_events']) {
   const broken={...db,transaction:<T>(work:Parameters<typeof db.transaction<T>>[0])=>db.transaction(tx=>work({query:async(sql:string,args?:unknown[])=>{
    if(sql.startsWith(prefix))throw Error('synthetic_write_failure');return tx.query(sql,args);
   }}))};
   await expect(sendCareSignal(broken,principal,command)).rejects.toThrow('synthetic_write_failure');
   expect((await pg.query('SELECT id FROM care_signals')).rows).toHaveLength(0);
   expect((await pg.query('SELECT id FROM outbox_events')).rows).toHaveLength(0);
  }
  expect(await sendCareSignal(db,principal,command)).toMatchObject({ok:true,value:{replay:false}});
  expect(await sendCareSignal(db,principal,command)).toMatchObject({ok:true,value:{replay:true}});
  expect((await pg.query("SELECT * FROM outbox_events WHERE type='care.signal_created'")).rows).toHaveLength(1);
  expect((await pg.query('SELECT id FROM care_notification_simulations')).rows).toHaveLength(0);
 } finally {await pg.close();}
});
it('migration does not backfill historical signal, and replay remains valid without an event',async()=>{
 const pg=await createFixture();
 try {
  await migrate(pg,'005_care_signals.sql');
  const client=id(992);
  await pg.query(`INSERT INTO care_signals(couple_id,sender_id,recipient_id,client_signal_id,membership_epoch,created_at)
   VALUES($1,$2,$3,$4,1,'2026-11-10T00:00:00Z')`,[c1,u1,u2,client]);
  await migrate(pg,'033_care_notification_simulations.sql');
  expect((await pg.query('SELECT id FROM outbox_events')).rows).toHaveLength(0);
  expect(await sendCareSignal({...adapter(pg),now:()=>new Date('2026-11-10T00:00:00Z')},principal,{coupleId:c1,membershipEpoch:1,clientId:client})).toMatchObject({ok:true,value:{replay:true}});
  expect((await pg.query('SELECT id FROM outbox_events')).rows).toHaveLength(0);
 }finally{await pg.close();}
});
