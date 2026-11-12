import { createChatDelete, type DeleteState } from '../src/auth/chat-delete';
import { deleteChatMessage } from '../src/chat/delete-transport';
import { row, uuid } from './chat-replies.fixture';
jest.mock('../src/chat/delete-transport', () => ({ deleteChatMessage: jest.fn() }));
const remove = jest.mocked(deleteChatMessage);
function fixture() {
 let generation=1, available=true, cookie:string|null='cookie', live=true;
 const session={scope:{userId:uuid(1),coupleId:uuid(2),membershipEpoch:1,sessionId:'local'},token:'cookie',credentialGeneration:1};
 const publish=jest.fn<void,[DeleteState]>(), denied=jest.fn(), accept=jest.fn(async()=>true);
 const credential=jest.fn(async()=>({credential:session}));
 const controller=createChatDelete('https://example.test',{
   capture:()=>available?{generation,session}:null, find:()=>live?row(1):undefined,
   credential,cookie:async()=>cookie,publish,denied,accept,
 },jest.fn(),()=>uuid(77));
 return {controller,publish,denied,accept,credential,session,
   setAvailable:(v:boolean)=>{available=v;},setCookie:(v:string|null)=>{cookie=v;},
   setLive:(v:boolean)=>{live=v;},change:()=>{generation++;},
   begin:()=>{controller.beginDelete(row(1).id);return controller.getSnapshot().confirmation!.token;}};
}
beforeEach(()=>remove.mockReset());
it('pins metadata only and ignores unavailable actions, stale confirmation and repeat while sending',async()=>{
 const f=fixture(); f.setAvailable(false); f.controller.beginDelete(row(1).id);
 expect(f.controller.getSnapshot().status).toBe('idle'); f.setAvailable(true);
 const token=f.begin(); f.setLive(false); await f.controller.confirmDelete(token);
 expect(f.controller.getSnapshot().status).toBe('error');expect(remove).not.toHaveBeenCalled();
 f.setLive(true); const fresh=f.begin(); let resolve!: (value:Awaited<ReturnType<typeof deleteChatMessage>>)=>void;
 remove.mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
 const run=f.controller.confirmDelete(fresh);await Promise.resolve();await Promise.resolve();
 await f.controller.retryDelete(); f.controller.cancelDelete(); f.controller.beginDelete(row(2).id);
 expect(remove).toHaveBeenCalledTimes(1);
 expect(Object.keys(remove.mock.calls[0][2].message).sort()).toEqual(['id','coupleId','senderId','clientId','seq','version','createdAt','replyToId'].sort());
 resolve({ok:false,error:'invalid_response'});await run;
 expect(f.controller.getSnapshot().status).toBe('unknown');
});
it('cookie change denies, transport throws retains pending, failed canonical acceptance remains unknown',async()=>{
 const f=fixture(); remove.mockRejectedValueOnce(Error());await f.controller.confirmDelete(f.begin());
 expect(f.controller.getSnapshot().status).toBe('unknown');
 remove.mockResolvedValueOnce({ok:false,error:'transport_error'}); f.setCookie('new'); await f.controller.retryDelete();expect(f.denied).toHaveBeenCalledWith('auth_required');
 f.setCookie('cookie');f.accept.mockResolvedValue(false);
 remove.mockResolvedValueOnce({ok:true,value:{commandId:uuid(77),replay:true,message:{...row(1),replyToId:null,deletedAt:'2026-11-12T00:00:00.000Z',body:null,version:2}}});
 await f.controller.retryDelete();expect(f.controller.getSnapshot()).toMatchObject({status:'unknown',error:'invalid_response'});
});
it('discovery failure retains exact pending and reset clears it',async()=>{
 const f=fixture(); f.credential.mockRejectedValueOnce(Error());await f.controller.confirmDelete(f.begin());
 expect(f.controller.getSnapshot().status).toBe('unknown');
 f.controller.reset(); await f.controller.retryDelete();expect(f.controller.getSnapshot().status).toBe('idle');expect(remove).not.toHaveBeenCalled();
});
