import { fixture, ack, envelope, error, date, uuid, context, settle } from './arrival-fixtures';
it('creates only explicitly and fences missing context, resets and removes listeners', async () => {
 const f=fixture(), listener=jest.fn(), stop=f.api.subscribe(listener); f.controller.sync(); expect(listener).not.toHaveBeenCalled();
 await f.api.save(); expect(f.api.getSnapshot()).toMatchObject({status:'saved',plan:date,fields:{label:''}});
 f.controller.reset(); stop();f.controller.reset(); f.api.setField('label','x');f.api.beginEdit();await f.api.save();await f.api.load();await f.api.retry();
 expect(f.operation).toHaveBeenCalledTimes(1);f.set(null);f.controller.sync();expect(f.api.getSnapshot().available).toBe(false);
});
it('keeps exact pending command and newer RAM after lost ACK; duplicate actions are inert',async()=>{
 const f=fixture();let release!:(r:Response)=>void;f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const work=f.api.save();await settle();
 await f.api.save();await f.api.retry();await f.api.load();f.api.beginEdit();f.api.setField('label','New unsaved');release(error('temporary',503));await work;
 expect(f.api.getSnapshot().status).toBe('retry');await f.api.save();await f.api.retry();
 expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());expect(f.command).toHaveBeenCalledTimes(1);
 expect(f.api.getSnapshot()).toMatchObject({status:'saved',fields:{label:'New unsaved'},pending:null});
});
it('loads missing plan, explicitly edits and retains no-op version, prevents implicit overwrite',async()=>{
 const f=fixture();f.operation.mockResolvedValueOnce(envelope({plan:null,asOf:'2028-02-28T00:00:00.000Z'}));await f.api.load();f.api.beginEdit();
 expect(f.api.getSnapshot()).toMatchObject({checked:true,editingVersion:0});
 for(const key of ['label','localDate','localTime','timezone','offset'] as const)f.api.setField(key,date[key]);await f.api.save();
 await f.api.save();expect(f.api.getSnapshot().status).toBe('invalid');f.api.beginEdit();await f.api.save();expect(f.api.getSnapshot().plan?.version).toBe(1);
});
it('conflict needs refreshed version and explicit form reload; older form cannot overwrite',async()=>{
 const f=fixture();f.operation.mockResolvedValueOnce(envelope({plan:date,asOf:'2028-02-29T00:00:00.000Z'}));await f.api.load();f.api.beginEdit();
 f.operation.mockResolvedValueOnce(error('version_conflict',409));await f.api.save();await f.api.save();await f.api.retry();f.api.beginEdit();
 expect(f.api.getSnapshot().requiresRefresh).toBe(true);
 f.operation.mockResolvedValueOnce(envelope({plan:{...date,version:2,label:'Partner'},asOf:'2028-02-29T00:01:00.000Z'}));await f.api.load();await f.api.save();
 expect(f.api.getSnapshot().status).toBe('conflict');
});
it.each(['version_conflict','idempotency_conflict'])('handles known conflict %s',async code=>{const f=fixture();f.operation.mockResolvedValue(error(code,409));await f.api.save();expect(f.api.getSnapshot()).toMatchObject({status:'conflict',pending:null});});
it.each([401,403,409])('scrubs denied scope %s',async status=>{const f=fixture();f.operation.mockResolvedValue(error('stale_membership',status));await f.api.save();expect(f.host.block).toHaveBeenCalled();expect(f.api.getSnapshot().available).toBe(false);});
it('distinguishes invalid, unavailable, unknown errors',async()=>{const f=fixture();f.operation.mockResolvedValueOnce(error('invalid_request',400));await f.api.save();expect(f.api.getSnapshot().status).toBe('invalid');f.operation.mockResolvedValueOnce(error('not_found',404));await f.api.load();expect(f.api.getSnapshot().status).toBe('unavailable');f.operation.mockResolvedValueOnce(error('not_found',404));await f.api.save();expect(f.api.getSnapshot().status).toBe('retry');});
it('rejects malformed response schemas, snapshots, identities and regressions',async()=>{
 for(const value of [{plan:date,asOf:'bad'},{plan:date,asOf:'2028-02-29T00:00:00.000Z',extra:1},{plan:{...date,id:'bad'},asOf:'2028-02-29T00:00:00.000Z'}]){const f=fixture();f.operation.mockResolvedValue(envelope(value));await f.api.load();expect(f.api.getSnapshot().error).toBe(true);}
 for(const change of [{version:0},{version:1,label:'Changed'},{id:uuid(10)},{creatorId:uuid(10)},{createdAt:'2027-01-01T00:00:00.000Z'}]){const f=fixture();await f.api.save();f.operation.mockResolvedValue(envelope({plan:{...date,...change},asOf:'2028-02-29T00:01:00.000Z'}));await f.api.load();expect(f.api.getSnapshot().error).toBe(true);}
 const f=fixture();await f.api.save();f.operation.mockResolvedValue(envelope({plan:null,asOf:'2028-02-29T00:00:00.000Z'}));await f.api.load();expect(f.api.getSnapshot().plan).toEqual(date);
});
it('rejects invalid commands, wrong ACK payload/version/identity and accepts canonical replay',async()=>{
 for(const item of [null,{...date,creatorId:uuid(8)},{...date,label:'Changed'},{...date,version:5}]){const f=fixture();f.operation.mockResolvedValue(ack(item));await f.api.save();expect(f.api.getSnapshot().status).toBe('retry');}
 const f=fixture();f.operation.mockResolvedValue(ack({...date,version:2,label:'Partner'},true));await f.api.save();expect(f.api.getSnapshot().plan?.label).toBe('Partner');
 const g=fixture();g.command.mockReturnValue('bad');await g.api.save();expect(g.api.getSnapshot().status).toBe('invalid');g.api.setField('offset','bad');await g.api.save();expect(g.operation).not.toHaveBeenCalled();
});
it('cancel preserves submitted operation/new input but drops a pending read response',async()=>{
 const f=fixture();let release!:(r:Response)=>void;f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const work=f.api.save();await settle();f.api.cancel();f.api.setField('label','Later');release(ack());await work;expect(f.api.getSnapshot().fields.label).toBe('Later');
 f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const load=f.api.load();await settle();f.api.cancel();release(envelope({plan:{...date,version:2},asOf:'2028-02-29T00:01:00.000Z'}));await load;expect(f.api.getSnapshot().plan?.version).toBe(1);
});
it('retains pending after refresh and invalidates late auth generations',async()=>{
 const f=fixture();f.operation.mockResolvedValueOnce(error('temporary',503));await f.api.save();f.operation.mockResolvedValueOnce(envelope({plan:date,asOf:'2028-02-29T00:00:00.000Z'}));await f.api.load();expect(f.api.getSnapshot().status).toBe('retry');
 const g=fixture();g.set(null);await g.api.save();expect(g.operation).not.toHaveBeenCalled();
 const h=fixture();h.discovery.mockResolvedValue(envelope({...context,membershipEpoch:2}));await h.api.save();expect(h.host.refresh).toHaveBeenCalled();
});
it('handles context errors, cookie changes and non-json',async()=>{
 for(const status of [401,503]){const f=fixture();f.discovery.mockResolvedValue(error('temporary',status));await f.api.save();expect(f.api.getSnapshot().status).toBe(status===401?'idle':'retry');}
 const f=fixture();f.host.getCookie.mockResolvedValueOnce('one').mockResolvedValueOnce('two');await f.api.save();expect(f.host.block).toHaveBeenCalled();
 const g=fixture();g.operation.mockResolvedValue(new Response('oops',{status:200}));await g.api.save();expect(g.api.getSnapshot().status).toBe('retry');
});
it('rejects metadata/clock/HTTP status drift and wrong receipt without losing command',async()=>{
 for(const response of [ack(date,false,uuid(77)),envelope({plan:date,replay:'yes',commandId:uuid(3),asOf:'2028-02-29T00:00:00.000Z'}),
 envelope({plan:date,replay:false,commandId:uuid(3),asOf:'2028-02-29T00:00:00.000Z'},201),new Response(JSON.stringify({ok:true,value:{plan:date,replay:false,commandId:uuid(3),asOf:'2028-02-29T00:00:00.000Z'},extra:1}),{status:200})]){
 const f=fixture();f.operation.mockResolvedValue(response);await f.api.save();expect(f.api.getSnapshot().status).toBe('retry');}
 const f=fixture();await f.api.save();f.operation.mockResolvedValue(envelope({plan:date,asOf:'2027-02-28T00:00:00.000Z'}));await f.api.load();expect(f.api.getSnapshot().error).toBe(true);
});
it('fences a late operation after context reset and scrubs changed cookies after request',async()=>{
 const f=fixture();let release!:(r:Response)=>void;f.operation.mockReturnValueOnce(new Promise(r=>{release=r;}));const work=f.api.save();await settle();f.controller.reset();release(ack());await work;expect(f.api.getSnapshot().available).toBe(false);
 for(const count of [2,3]){const g=fixture();for(let n=0;n<count;n++)g.host.getCookie.mockResolvedValueOnce('same');g.host.getCookie.mockResolvedValue('changed');await g.api.save();expect(g.host.block).toHaveBeenCalled();}
});
