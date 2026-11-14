import { expect,it } from 'vitest';
import { simulateMorningSlot as run } from '../src/morning-notifications.ts';
import type { Database,SqlExecutor } from '../src/contracts.ts';
import { id } from './fixtures.ts';
const slotId=id(71),couple=id(72),sender=id(73),recipient=id(74);
type Options={now?:string;release?:string;prepared?:boolean;missing?:boolean;vanished?:boolean;pairStatus?:string;epoch?:number;members?:string[];pref?:Record<string,unknown>|null;prior?:Record<string,unknown>;fail?:boolean};
function fixture(o:Options={}){
 const sqls:string[]=[];let stored:Record<string,unknown>|undefined=o.prior;
 const db:Database={now:()=>{throw Error('application_clock_must_not_be_used');},transaction:work=>work({query:async<T>(sql:string,args?:unknown[])=>{
  sqls.push(sql);let rows:unknown[];
  if(sql==='SELECT couple_id FROM morning_slots WHERE id=$1')rows=o.missing?[]:[{couple_id:couple}];
  else if(sql.startsWith('SELECT status,membership_epoch'))rows=[{status:o.pairStatus??'active',membership_epoch:o.epoch??1}];
  else if(sql.includes('FROM morning_slots WHERE id=$1 AND'))rows=o.vanished?[]:[{id:slotId,couple_id:couple,membership_epoch:1,sender_id:sender,recipient_id:recipient,release_at:o.release??'2026-01-01T09:00:00Z'}];
  else if(sql.includes('FROM couple_members'))rows=(o.members??[sender,recipient]).map(user_id=>({user_id}));
  else if(sql.includes('clock_timestamp()'))rows=[{now:o.now??'2026-01-01T09:00:00.000000Z',released:Date.parse(o.now??'2026-01-01T09:00:00Z')>=Date.parse(o.release??'2026-01-01T09:00:00Z')}];
  else if(sql.includes('FROM morning_notification_simulations'))rows=stored?[stored]:[];
  else if(sql.includes('FROM morning_content'))rows=[{prepared:o.prepared??true}];
  else if(sql.includes('FROM notification_preferences'))rows=o.pref?[o.pref]:[];
  else if(sql.startsWith('INSERT INTO morning_notification_simulations')){
   if(o.fail)throw Error('write_failure');
   stored={id:id(75),slot_id:args![0],couple_id:args![1],recipient_id:args![2],membership_epoch:args![3],state:args![4],reason:args![5],evaluated_at:String(args![6]),preference_version:args![7]};rows=[stored];
  }else throw Error('unexpected SQL '+sql);
  return {rows:rows as T[]};
 } } as SqlExecutor)};
 return {db,sqls,getStored:()=>stored};
}
const enabled={care:false,chat:false,letter:true,version:2,quiet_start:null,quiet_end:null,timezone:null};
it('before actual release uniform filled/empty outcomes, no readiness/preferences/prior read and no writes',async()=>{
 for(const prepared of [true,false]){
  const x=fixture({now:'2026-01-01T08:59:59.999Z',prepared,prior:{reason:'allowed'}});
  expect(await run(x.db,slotId)).toEqual({ok:true,value:{state:'not_due',simulationOnly:true}});
  expect(x.sqls.some(s=>/morning_content|notification_preferences|morning_notification_simulations|INSERT/.test(s))).toBe(false);
  expect(x.sqls.filter(s=>s.includes('clock_timestamp'))).toHaveLength(1);
 }
});
it('actual exact release evaluates letter-only defaults/opt-in/quiet without body/draft/open state',async()=>{
 for(const [pref,reason,version] of [[null,'disabled',0],[enabled,'allowed',2],[{...enabled,letter:false},'disabled',2],[{...enabled,quiet_start:'09:00',quiet_end:'10:00',timezone:'UTC'},'quiet_hours',2]] as const){
  const x=fixture({pref});expect(await run(x.db,slotId)).toMatchObject({ok:true,value:{reason,preferenceVersion:version,asOf:'2026-01-01T09:00:00.000000Z',simulationOnly:true,historicalObservation:true,replay:false}});
  expect(x.sqls.some(s=>/\bbody\b|morning_drafts|morning_openings|filled_at|opened_at/.test(s))).toBe(false);
  expect(x.sqls.filter(s=>s.includes('clock_timestamp'))).toHaveLength(1);
  expect(x.sqls.find(s=>s.includes('FROM morning_content'))).toContain('s.release_at <= $2::timestamptz');
 }
});
it('missed reads no prefs; unavailable reads neither readiness nor prefs',async()=>{
 const missed=fixture({prepared:false,pref:enabled});expect(await run(missed.db,slotId)).toMatchObject({ok:true,value:{reason:'missed',preferenceVersion:null}});
 expect(missed.sqls.some(s=>s.includes('FROM notification_preferences'))).toBe(false);
 for(const o of [{pairStatus:'closed'},{epoch:2},{members:[sender]},{members:[sender,id(99)]},{members:[recipient,id(99)]}]){
  const x=fixture(o);expect(await run(x.db,slotId)).toMatchObject({ok:true,value:{reason:'unavailable',preferenceVersion:null}});
  expect(x.sqls.some(s=>/morning_content|FROM notification_preferences/.test(s))).toBe(false);
 }
});
it('replay is original observation regardless of current prefs/leave and cannot bypass release gate',async()=>{
 const x=fixture({pref:enabled});const first=await run(x.db,slotId);const prior=x.getStored();
 const replay=fixture({prior,pairStatus:'closed',prepared:false});
 expect(await run(replay.db,slotId)).toEqual(first.ok?{ok:true,value:{...first.value,replay:true}}:null);
 expect(replay.sqls.some(s=>/morning_content|notification_preferences|INSERT/.test(s))).toBe(false);
 expect(await run(fixture({prior,now:'2026-01-01T08:59:59Z'}).db,slotId)).toEqual({ok:true,value:{state:'not_due',simulationOnly:true}});
});
it('validation, missing source, invalid SQL time and SQL failures do not become success',async()=>{
 expect(await run(fixture().db,'bad')).toEqual({ok:false,error:'invalid_request'});
 for(const o of [{missing:true},{vanished:true}])expect(await run(fixture(o).db,slotId)).toEqual({ok:false,error:'not_found'});
 for(const o of [{now:'bad'},{release:'bad'}])await expect(run(fixture(o).db,slotId)).rejects.toThrow('invalid_server_clock');
 await expect(run(fixture({fail:true}).db,slotId)).rejects.toThrow('write_failure');
});
it('exact SQL microsecond timestamp is retained for observation, not truncated by policy Date conversion',async()=>{
 const instant='2026-01-01T09:00:00.123456Z';const x=fixture({now:instant,pref:enabled});
 expect(await run(x.db,slotId)).toMatchObject({ok:true,value:{asOf:instant,reason:'allowed'}});
 expect(x.getStored()?.evaluated_at).toBe(instant);
 expect(x.sqls.find(s=>s.includes('clock_timestamp'))).toContain('instant >= $1::timestamptz AS released');
});
