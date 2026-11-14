import { validParting, partingProgress, partingOrder, instant, isPartingDates } from '../src/auth/partings-state';
import { date, context, uuid, fixture, envelope, ack } from './partings-fixtures';
it.each(['id','creatorId','coupleId','membershipEpoch','title','startDate','endDate','timezone','startsAt','endsAt','createdAt','version'])('rejects invalid canonical %s', field => {
 expect(validParting({...date,[field]:field==='title'?'':'bad'},context)).toBe(false);
});
it('validates complete canonical metadata and bounds',()=>{
 expect(validParting(date,context)).toBe(true); expect(validParting(null,context)).toBe(false); expect(validParting({...date,extra:1},context)).toBe(false);
 expect(validParting(date,{...context,state:'waiting_partner'})).toBe(false);
 for(const version of [0,-1,2147483648,1.5])expect(validParting({...date,version},context)).toBe(false);
 expect(validParting({...date,title:' x '},context)).toBe(false);expect(validParting({...date,endsAt:date.startsAt},context)).toBe(false);
 expect(instant(1)).toBe(false);expect(instant('bad')).toBe(false);expect(isPartingDates('1999-01-01','2000-01-01')).toBe(false);
 expect(isPartingDates('2100-01-01','2101-01-01')).toBe(false);expect(isPartingDates('2028-03-02','2028-03-01')).toBe(false);
 expect(partingOrder(date,date)).toBe(0);expect(partingOrder(date,{...date,id:uuid(10)})).toBeLessThan(0);
 expect(partingOrder(date,{...date,startsAt:'2029-01-01T00:00:00.000Z'})).toBeLessThan(0);
});
it('uses server instant and calendar days across DST, end-exclusive and no device clock',()=>{
 const p={...date,startDate:'2026-03-08',endDate:'2026-03-08',timezone:'America/New_York',startsAt:'2026-03-08T05:00:00.000Z',endsAt:'2026-03-09T04:00:00.000Z'};
 expect(validParting(p,context)).toBe(true);
 expect(partingProgress(p,'2026-03-08T04:59:59.000Z')).toEqual({state:'upcoming',days:1});
 expect(partingProgress(p,p.startsAt)).toEqual({state:'current',days:1});expect(partingProgress(p,'2026-03-09T03:59:59.000Z')).toEqual({state:'current',days:1});
 expect(partingProgress(p,p.endsAt)).toEqual({state:'past',days:0});
});
it.each([null,[],{}, {ok:false},{ok:true,value:null}])('rejects malformed envelope%p',async b=>{
 const f=fixture();f.operation.mockResolvedValue(new Response(JSON.stringify(b)));await f.api.create();expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([{asOf:'bad'},{commandId:uuid(99)},{replay:'true'},{parting:{...date,title:'Different'}},{parting:{...date,creatorId:uuid(99)}},{parting:{...date,startDate:'2028-02-28'}},{parting:{...date,version:2}}])('rejects mismatched ACK%p',async change=>{
 const f=fixture();f.operation.mockResolvedValue(envelope({parting:date,commandId:uuid(3),replay:false,asOf:'2028-02-29T00:00:00.000Z',...change}));await f.api.create();expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([{partings:null},{partings:[null]},{partings:[date,date]},{partings:Array(101).fill(date)},{partings:[],limit:50},{partings:[{...date,coupleId:uuid(99)}]},{partings:[{...date,id:uuid(10)},date]},{asOf:'bad'}])('rejects malformed list%p',async change=>{
 const f=fixture();f.operation.mockResolvedValue(envelope({partings:[],limit:100,asOf:'2028-02-29T00:00:00.000Z',...change}));await f.api.list();expect(f.api.getSnapshot().error).toBe(true);
});
it('does not accept omitted known rows or a lower-version list',async()=>{
 const f=fixture();await f.api.create();f.operation.mockResolvedValue(envelope({partings:[],limit:100,asOf:'2028-02-29T00:00:00.000Z'}));await f.api.list();expect(f.api.getSnapshot().partings).toEqual([date]);expect(f.api.getSnapshot().error).toBe(true);
});
it('edits with CAS and allows unchanged no-op version; clears only old form',async()=>{
 const f=fixture();await f.api.create();f.api.beginEdit('bad');f.api.beginEdit(date.id);f.operation.mockResolvedValue(ack(date));await f.api.create();
 expect(f.api.getSnapshot().status).toBe('saved');expect(f.operation.mock.calls[1][0].method).toBe('PATCH');
 f.api.beginEdit(date.id);f.api.setDraft('Changed');f.operation.mockResolvedValue(ack({...date,title:'Changed',version:2}));await f.api.create();expect(f.api.getSnapshot().partings[0].version).toBe(2);
 f.api.beginEdit(date.id);f.operation.mockResolvedValue(ack(date,true));await f.api.create();expect(f.api.getSnapshot().status).toBe('retry');
});
it('retains newer canonical on old immutable replay and detects stale editor',async()=>{
 const f=fixture();await f.api.create();f.api.beginEdit(date.id);
 f.operation.mockResolvedValue(envelope({partings:[{...date,version:2,title:'Later'}],limit:100,asOf:'2028-02-29T00:00:00.000Z'}));await f.api.list();await f.api.create();expect(f.api.getSnapshot().status).toBe('conflict');
});

it('rejects shifted or ambiguous midnight snapshots',()=>{
 expect(validParting({...date,startsAt:'2028-02-28T16:00:00.000Z'},context)).toBe(false);
 expect(validParting({...date,startDate:'2026-11-01',endDate:'2026-11-01',timezone:'America/Havana',startsAt:'2026-11-01T04:00:00.000Z',endsAt:'2026-11-02T05:00:00.000Z'},context)).toBe(false);
});
it('rejects same-version changed canonical values and omitted complete-list entries',async()=>{
 const f=fixture();await f.api.create();f.api.setDraft('Other');f.api.setStartDate(date.startDate);f.api.setEndDate(date.endDate);f.api.setTimezone(date.timezone);
 f.operation.mockResolvedValue(ack({...date,title:'Other'}));await f.api.create();expect(f.api.getSnapshot().status).toBe('retry');expect(f.api.getSnapshot().partings[0]).toEqual(date);
 f.operation.mockResolvedValue(envelope({partings:[{...date,title:'Other'}],limit:100,asOf:'2028-02-29T00:00:00.000Z'}));await f.api.list();expect(f.api.getSnapshot().error).toBe(true);expect(f.api.getSnapshot().partings[0]).toEqual(date);
});
it('retains higher version on original-create exact replay',async()=>{
 const f=fixture(); f.operation.mockResolvedValueOnce(new Response('oops',{status:503}));await f.api.create();
 f.operation.mockResolvedValueOnce(envelope({partings:[{...date,version:2,title:'Later'}],limit:100,asOf:'2028-02-29T00:00:00.000Z'}));await f.api.list();
 f.operation.mockResolvedValueOnce(ack(date,true));await f.api.retry();expect(f.api.getSnapshot().partings[0].title).toBe('Later');
});
