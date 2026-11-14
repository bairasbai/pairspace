import { fixture, ack, envelope, error, date, uuid, context, settle } from './notification-preferences-fixtures';
const asOf='2028-02-29T00:00:00.000Z';
it('saves only explicitly, fences unavailable actions and subscriptions',async()=>{
 const f=fixture(),listener=jest.fn(),stop=f.api.subscribe(listener);f.controller.sync();expect(listener).not.toHaveBeenCalled();await f.api.save();
 expect(f.api.getSnapshot()).toMatchObject({status:'saved',preferences:date,editingVersion:1});f.controller.reset();stop();f.controller.reset();
 f.api.setCategory('care',true);f.api.setQuiet(null);f.api.beginEdit();await f.api.save();await f.api.retry();await f.api.load();await f.api.preview('care');expect(f.operation).toHaveBeenCalledTimes(1);
 f.set(null);f.controller.sync();expect(f.api.getSnapshot().available).toBe(false);
});
it('preserves immutable quiet command despite caller mutation and newer draft through lost ACK',async()=>{
 const f=fixture();const quiet={start:'22:00',end:'07:00',timezone:'UTC'};f.api.setQuiet(quiet);quiet.start='23:00';
 let release!:(r:Response)=>void;f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const work=f.api.save();await settle();
 f.api.setCategory('chat',true);f.api.setQuiet(null);await f.api.save();await f.api.retry();await f.api.load();f.api.beginEdit();release(error('temporary',503));await work;
 f.operation.mockResolvedValueOnce(ack({...date,quiet:{start:'22:00',end:'07:00',timezone:'UTC'}}));await f.api.save();await f.api.retry();
 expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());expect(f.command).toHaveBeenCalledTimes(1);
 expect(f.api.getSnapshot()).toMatchObject({status:'saved',fields:{chat:true,quiet:null},pending:null});
});
it('loads defaults then edits, supports version1 first save and stable no-op',async()=>{
 const f=fixture();f.operation.mockResolvedValueOnce(envelope({preferences:{...date,version:0},asOf}));await f.api.load();f.api.beginEdit();await f.api.save();
 expect(f.api.getSnapshot().preferences?.version).toBe(1);await f.api.save();expect(f.api.getSnapshot().preferences?.version).toBe(1);
 f.api.cancel();await f.api.save();expect(f.api.getSnapshot().status).toBe('invalid');f.api.beginEdit();expect(f.api.getSnapshot().editingVersion).toBe(1);
});
it.each(['version_conflict','idempotency_conflict'])('requires refresh and explicit form reload on %s',async code=>{
 const f=fixture();f.operation.mockResolvedValueOnce(envelope({preferences:date,asOf}));await f.api.load();f.api.beginEdit();f.operation.mockResolvedValueOnce(error(code,409));await f.api.save();
 await f.api.save();await f.api.retry();f.api.beginEdit();expect(f.api.getSnapshot().requiresRefresh).toBe(true);
 f.operation.mockResolvedValueOnce(envelope({preferences:{...date,version:2,chat:true},asOf}));await f.api.load();await f.api.save();expect(f.api.getSnapshot().status).toBe('conflict');
});
it.each([401,403,409])('scrubs actor scope on %s',async status=>{const f=fixture();f.operation.mockResolvedValue(error('stale_membership',status));await f.api.save();expect(f.host.block).toHaveBeenCalled();expect(f.api.getSnapshot().available).toBe(false);});
it('distinguishes invalid, missing endpoint and transient errors',async()=>{
 const f=fixture();f.operation.mockResolvedValueOnce(error('invalid_request',400));await f.api.save();expect(f.api.getSnapshot().status).toBe('invalid');
 f.operation.mockResolvedValueOnce(error('not_found',404));await f.api.load();expect(f.api.getSnapshot().status).toBe('unavailable');
 f.operation.mockResolvedValueOnce(error('not_found',404));await f.api.save();expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects malformed, partner, stale and unexpected-field responses',async()=>{
 for(const value of [{preferences:date,asOf:'bad'},{preferences:date,asOf,extra:1},{preferences:{...date,userId:uuid(8)},asOf}]){const f=fixture();f.operation.mockResolvedValue(envelope(value));await f.api.load();expect(f.api.getSnapshot().error).toBe(true);}
 for(const change of [{version:0},{version:1,care:true}]){const f=fixture();await f.api.save();f.operation.mockResolvedValue(envelope({preferences:{...date,...change},asOf}));await f.api.load();expect(f.api.getSnapshot().error).toBe(true);}
 const f=fixture();await f.api.save();f.operation.mockResolvedValue(envelope({preferences:date,asOf:'2027-01-01T00:00:00.000Z'}));await f.api.load();expect(f.api.getSnapshot().error).toBe(true);
});
it('validates command and exact receipt, but accepts newer canonical replay',async()=>{
 for(const response of [ack(null),ack({...date,version:5}),ack({...date,care:true}),ack(date,false,uuid(88)),envelope({preferences:date,replay:'yes',commandId:uuid(3),asOf}),envelope({preferences:date,replay:false,commandId:uuid(3),asOf},201),new Response('oops',{status:200})]){const f=fixture();f.operation.mockResolvedValue(response);await f.api.save();expect(f.api.getSnapshot().status).toBe('retry');}
 const f=fixture();f.operation.mockResolvedValue(ack({...date,version:2,chat:true},true));await f.api.save();expect(f.api.getSnapshot().preferences?.chat).toBe(true);
 const g=fixture();g.command.mockReturnValue('bad');await g.api.save();expect(g.api.getSnapshot().status).toBe('invalid');
 const h=fixture();h.api.setQuiet({start:'22:00',end:'22:00',timezone:'UTC'});await h.api.save();expect(h.operation).not.toHaveBeenCalled();
});
it('cancel fences reads/previews, not submitted writes; preserves newer form',async()=>{
 const f=fixture();let release!:(r:Response)=>void;f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const work=f.api.save();await settle();f.api.cancel();f.api.setCategory('care',true);release(ack());await work;expect(f.api.getSnapshot().fields.care).toBe(true);
 for(const action of ['load','preview'] as const){f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const work=action==='load'?f.api.load():f.api.preview('care');await settle();f.api.cancel();release(envelope({preferences:{...date,version:2},asOf}));await work;expect(f.api.getSnapshot().preferences?.version).toBe(1);}
});
it('refresh preserves pending; auth generation/context/cookie changes fence results',async()=>{
 const f=fixture();f.operation.mockResolvedValueOnce(error('temporary',503));await f.api.save();f.operation.mockResolvedValueOnce(envelope({preferences:date,asOf}));await f.api.load();expect(f.api.getSnapshot().status).toBe('retry');
 const g=fixture();g.set(null);await g.api.save();expect(g.operation).not.toHaveBeenCalled();const h=fixture();h.discovery.mockResolvedValue(envelope({...context,membershipEpoch:2}));await h.api.save();expect(h.host.refresh).toHaveBeenCalled();
 for(const count of [1,2,3]){const p=fixture();for(let n=0;n<count;n++)p.host.getCookie.mockResolvedValueOnce('same');p.host.getCookie.mockResolvedValue('changed');await p.api.save();expect(p.host.block).toHaveBeenCalled();}
});
it('handles discovery failures and reset while request in flight',async()=>{
 for(const status of [401,503]){const f=fixture();f.discovery.mockResolvedValue(error('temporary',status));await f.api.save();expect(f.api.getSnapshot().status).toBe(status===401?'idle':'retry');}
 const f=fixture();let release!:(r:Response)=>void;f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const work=f.api.save();await settle();f.controller.reset();release(ack());await work;expect(f.api.getSnapshot().available).toBe(false);
});
it('preview is a separate private saved-rule simulation with strict schema and version',async()=>{
 const f=fixture();const result={allowedByPreferences:false,reason:'disabled',category:'care',asOf,preferenceVersion:0,simulationOnly:true};
 f.operation.mockResolvedValueOnce(envelope(result));await f.api.preview('care');expect(f.api.getSnapshot().policyPreview).toEqual(result);expect(f.api.getSnapshot().checked).toBe(false);
 expect(f.operation.mock.calls[0][0].url).toContain('/preview?membership_epoch=1&category=care');expect(f.operation.mock.calls[0][0].method).toBe('GET');
 f.api.setCategory('care',true);expect(f.api.getSnapshot().policyPreview).toBeNull();await f.api.preview('other' as never);expect(f.operation).toHaveBeenCalledTimes(1);
 f.operation.mockResolvedValueOnce(ack({...date,care:true}));await f.api.save();f.operation.mockResolvedValueOnce(envelope(result));await f.api.preview('care');expect(f.api.getSnapshot().error).toBe(true);
 f.operation.mockResolvedValueOnce(envelope({...result,category:'chat',preferenceVersion:1}));await f.api.preview('care');expect(f.api.getSnapshot().policyPreview).toBeNull();
});

it('rejects impossible version-zero preview even without a prior preferences read',async()=>{
 for(const reason of ['allowed','quiet_hours']){
  const f=fixture();f.operation.mockResolvedValueOnce(envelope({allowedByPreferences:reason==='allowed',reason,category:'care',asOf,preferenceVersion:0,simulationOnly:true}));
  await f.api.preview('care');expect(f.api.getSnapshot().policyPreview).toBeNull();expect(f.api.getSnapshot().error).toBe(true);
 }
});
it('same-version preview must match the saved disabled/quiet policy, not the unsaved form',async()=>{
 for(const [fields,time,reason] of [
  [{care:false,quiet:null},'2028-03-01T12:00:00.000Z','allowed'],
  [{care:false,quiet:null},'2028-03-01T23:00:00.000Z','quiet_hours'],
  [{care:true,quiet:{start:'22:00',end:'07:00',timezone:'UTC'}},'2028-03-01T22:00:00.000Z','allowed'],
  [{care:true,quiet:{start:'22:00',end:'07:00',timezone:'UTC'}},'2028-03-01T22:00:00.000Z','disabled'],
  [{care:true,quiet:{start:'22:00',end:'07:00',timezone:'UTC'}},'2028-03-02T07:00:00.000Z','quiet_hours'],
 ] as const){
  const f=fixture();f.operation.mockResolvedValueOnce(envelope({preferences:{...date,...fields},asOf}));await f.api.load();
  f.api.setCategory('care',!fields.care);
  f.operation.mockResolvedValueOnce(envelope({allowedByPreferences:reason==='allowed',reason,category:'care',asOf:time,preferenceVersion:1,simulationOnly:true}));
  await f.api.preview('care');expect(f.api.getSnapshot().policyPreview).toBeNull();expect(f.api.getSnapshot().error).toBe(true);
 }
});
it('accepts legitimate saved-policy inclusive-start/exclusive-end boundaries and newer unknown version',async()=>{
 const f=fixture();f.operation.mockResolvedValueOnce(envelope({preferences:{...date,care:true,quiet:{start:'22:00',end:'07:00',timezone:'UTC'}},asOf}));await f.api.load();
 for(const [time,reason] of [['2028-03-01T21:59:00.000Z','allowed'],['2028-03-01T22:00:00.000Z','quiet_hours'],['2028-03-02T06:59:00.000Z','quiet_hours'],['2028-03-02T07:00:00.000Z','allowed']] as const){
  const result={allowedByPreferences:reason==='allowed',reason,category:'care',asOf:time,preferenceVersion:1,simulationOnly:true};
  f.operation.mockResolvedValueOnce(envelope(result));await f.api.preview('care');expect(f.api.getSnapshot().policyPreview).toEqual(result);expect(f.api.getSnapshot().error).toBe(false);
 }
 const newer={allowedByPreferences:false,reason:'disabled',category:'care',asOf:'2028-03-03T12:00:00.000Z',preferenceVersion:2,simulationOnly:true};
 f.operation.mockResolvedValueOnce(envelope(newer));await f.api.preview('care');expect(f.api.getSnapshot().policyPreview).toEqual(newer);
});
