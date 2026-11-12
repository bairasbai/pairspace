import { fixture, message, row, deferred, settle, envelope, uuid, } from './chat-replies.fixture';
const token = (f: ReturnType<typeof fixture>) => f.controller.getSnapshot().deleteState!.confirmation!.token;
it('requires own validated target and explicit current confirmation; cancel sends nothing', async () => {
 const f = fixture(); await f.login();
 f.controller.beginDelete(uuid(999)); expect(f.controller.getSnapshot().deleteState).toBeUndefined();
 f.controller.beginDelete(row(250).id); const old = token(f);
 f.controller.cancelDelete(); await f.controller.confirmDelete(old); expect(f.remove).not.toHaveBeenCalled();
 f.controller.beginDelete(row(250).id); const stale = token(f);
 f.controller.beginDelete(row(249).id); await f.controller.confirmDelete(stale);
 expect(f.remove).not.toHaveBeenCalled();
 await f.controller.confirmDelete(token(f));
 expect(f.remove).toHaveBeenCalledTimes(1);
 expect(f.controller.getSnapshot().messages.find(m => m.id === row(249).id)?.body).toBeNull();
 expect(f.controller.getSnapshot().deleteState?.status).toBe('deleted');
});
it('unknown deletion retries exact target/command and preserves newer draft and reply selection', async () => {
 const f = fixture(); await f.login(); f.controller.beginDelete(row(250).id);
 f.remove.mockRejectedValueOnce(Error('offline'));
 await f.controller.confirmDelete(token(f));
 expect(f.controller.getSnapshot().deleteState?.status).toBe('unknown');
 f.controller.cancelDelete(); f.controller.beginDelete(row(249).id);
 f.controller.setDraft('new draft'); f.controller.setReplyTarget(row(248).id);
 await f.controller.retryDelete();
 expect(await f.remove.mock.calls[0][0].clone().text()).toBe(await f.remove.mock.calls[1][0].clone().text());
 expect(f.controller.getSnapshot()).toMatchObject({draft:'new draft',replyTarget:{id:row(248).id}});
});
it('held ACK never overwrites new draft and selected reply, and old account ACK cannot publish', async () => {
 const f = fixture(); await f.login(); f.controller.beginDelete(row(250).id);
 const held = deferred(); f.remove.mockReturnValueOnce(held.promise);
 const deleting = f.controller.confirmDelete(token(f)); await settle();
 f.controller.setDraft('new'); f.controller.setReplyTarget(row(249).id);
 held.resolve(envelope({commandId:uuid(20),replay:false,message:{...message(250),body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'}}));
 await deleting; expect(f.controller.getSnapshot()).toMatchObject({draft:'new',replyTarget:{id:row(249).id}});
 f.controller.beginDelete(row(249).id); const late = deferred(); f.remove.mockReturnValueOnce(late.promise);
 const second = f.controller.confirmDelete(token(f)); await settle();
 await f.controller.signOut(); await f.login(); f.controller.setDraft('new session');
 late.resolve(envelope({commandId:uuid(21),replay:false,message:{...message(249),body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'}}));
 await second; expect(f.controller.getSnapshot().draft).toBe('new session');
 expect(f.controller.getSnapshot().deleteState).toBeUndefined();
});
it('own original outside window can be deleted; stale live read cannot resurrect it', async () => {
 const f = fixture(); await f.login(); await f.controller.openReplyTarget(row(251).id);
 f.controller.beginDelete(row(1).id); await f.controller.confirmDelete(token(f));
 expect(f.controller.getSnapshot().replyDetail?.body).toBeNull();
 f.controller.closeReplyDetail(); await f.controller.openReplyTarget(row(251).id);
 expect(f.controller.getSnapshot().replyDetail).toBeUndefined();
 expect(f.controller.getSnapshot().error).toBe('invalid_response');
});
it.each(['version_conflict','message_unavailable','idempotency_conflict'])('definitive %s preserves draft without automatic retry', async error => {
 const f = fixture(); await f.login(); f.controller.setDraft('keep'); f.controller.beginDelete(row(250).id);
 f.remove.mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error}),{status:409}));
 await f.controller.confirmDelete(token(f)); await f.controller.retryDelete();
 expect(f.remove).toHaveBeenCalledTimes(1); expect(f.controller.getSnapshot().draft).toBe('keep');
 expect(f.controller.getSnapshot().deleteState).toMatchObject({status:'error',error});
});
it('partner message cannot be selected and auth denial clears confirmation state', async () => {
 const f=fixture(); await f.login();
 f.history.mockImplementationOnce(async request=>envelope({messages:[{...message(300),senderId:uuid(999)}],readId:new URL(request.url).searchParams.get('read_id'),hasOlder:false,hasNewer:false,olderCursor:null,newerCursor:null}));
 await f.controller.loadLatest(); f.controller.beginDelete(row(300).id); expect(f.remove).not.toHaveBeenCalled();
 expect(f.controller.getSnapshot().deleteState).toBeUndefined();
 await f.controller.loadOldest(); f.controller.beginDelete(row(1).id);
 f.remove.mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error:'unavailable'}),{status:403}));
 await f.controller.confirmDelete(token(f)); expect(f.controller.getSnapshot().phase).toBe('blocked');
 expect(f.controller.getSnapshot().deleteState).toBeUndefined();
});

it('canonical already-deleted refusal scrubs old body immediately and preserves unrelated newer draft', async () => {
 const f=fixture(); await f.login(); f.controller.setReplyTarget(row(250).id);
 f.controller.beginDelete(row(250).id); f.controller.setDraft('unrelated draft');
 f.remove.mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error:'message_deleted',value:{
   commandId:uuid(20),message:{...message(250),body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'},
 }}),{status:409}));
 await f.controller.confirmDelete(token(f));
 expect(f.controller.getSnapshot().messages.find(m=>m.id===row(250).id)?.body).toBeNull();
 expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
 expect(f.controller.getSnapshot().draft).toBe('unrelated draft');
 expect(f.controller.getSnapshot().deleteState).toMatchObject({status:'error',error:'message_deleted'});
});
it('foreign canonical refusal cannot remove selected or another message', async () => {
 const f=fixture();await f.login();f.controller.beginDelete(row(250).id);
 f.remove.mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error:'message_deleted',value:{
   commandId:uuid(20),message:{...message(249),body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'},
 }}),{status:409}));
 await f.controller.confirmDelete(token(f));
 expect(f.controller.getSnapshot().messages.find(m=>m.id===row(250).id)?.body).not.toBeNull();
 expect(f.controller.getSnapshot().messages.find(m=>m.id===row(249).id)?.body).not.toBeNull();
 expect(f.controller.getSnapshot().deleteState?.status).toBe('unknown');
});
