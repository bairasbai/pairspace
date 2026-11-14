import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {c1,c2,createFixture,id,u1,u2} from './fixtures.ts';
it('morning observation concrete identity, release time, shape and immutable guards',async()=>{
 const pg=await createFixture();try{
  for(const file of ['024_morning_ritual.sql','035_morning_notification_simulations.sql'])
   await pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await pg.query(`INSERT INTO morning_preferences(couple_id,membership_epoch,user_id,timezone,local_time,version)
   VALUES($1,1,$2,'UTC','08:00',1)`,[c1,u2]);
  for(const [slot,date] of [[id(9501),'2000-01-02'],[id(9502),'2100-01-02']])
   await pg.query(`INSERT INTO morning_slots(id,couple_id,membership_epoch,sender_id,recipient_id,local_date,local_time,timezone,utc_offset,release_at,preference_version,created_at)
    VALUES($1,$2,1,$3,$4,$5::text::date,'08:00','UTC','+00:00',($5::text||'T08:00:00Z')::timestamptz,1,($5::text||'T07:00:00Z')::timestamptz)`,[slot,c1,u1,u2,date]);
  const insert=(slot=id(9501),couple=c1,recipient=u2,epoch=1,state='simulation_blocked',reason='missed',pref:number|null=null,time='2000-01-02T08:00:00Z')=>pg.query(`INSERT INTO morning_notification_simulations
   (slot_id,couple_id,recipient_id,membership_epoch,state,reason,preference_version,evaluated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[slot,couple,recipient,epoch,state,reason,pref,time]);
  expect((await pg.query('SELECT id FROM morning_notification_simulations')).rows).toHaveLength(0);
  await expect(insert(id(9502),c1,u2,1,'simulation_blocked','missed',null,'2100-01-02T08:00:00Z')).rejects.toThrow('morning_simulation_not_released');
  await expect(insert(id(9501),c1,u2,1,'simulation_blocked','missed',null,'2000-01-02T07:59:59Z')).rejects.toThrow('morning_simulation_not_released');
  for(const args of [[id(9599),c1,u2,1],[id(9501),c2,u2,1],[id(9501),c1,u1,1],[id(9501),c1,u2,2]] as const)
   await expect(insert(args[0],args[1],args[2],args[3])).rejects.toThrow();
  for(const [state,reason,pref] of [['simulation_eligible','missed',null],['simulation_blocked','allowed',0],
   ['simulation_blocked','missed',0],['simulation_blocked','unavailable',1],['simulation_eligible','allowed',null],
   ['simulation_blocked','disabled',null],['simulation_blocked','quiet_hours',-1],['delivered','allowed',0]] as const)
   await expect(insert(id(9501),c1,u2,1,state,reason,pref)).rejects.toThrow();
  await expect(insert(id(9501),c1,u2,1,'simulation_blocked','missed',null,'infinity')).rejects.toThrow();
  await insert();
  await expect(insert()).rejects.toThrow();
  await expect(pg.exec("UPDATE morning_notification_simulations SET reason='unavailable'")).rejects.toThrow('morning_simulation_immutable');
  await expect(pg.exec('DELETE FROM morning_notification_simulations')).rejects.toThrow('morning_simulation_immutable');
  for(const table of ['morning_content','morning_openings','outbox_events'])expect((await pg.query('SELECT * FROM '+table)).rows).toHaveLength(0);
 }finally{await pg.close();}
});
