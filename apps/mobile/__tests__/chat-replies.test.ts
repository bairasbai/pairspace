import { fixture, message, row, uuid, context, envelope, deferred, settle } from './chat-replies.fixture';
it('selects validated target, opens original beyond200 without graft, sends exact target and leaves history unchanged',async()=>{
 const f=fixture();await f.login();f.controller.setReplyTarget(uuid(999));expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
 const rows=f.controller.getSnapshot().messages;await f.controller.openReplyTarget(row(251).id);
 expect(f.controller.getSnapshot().replyDetail).toEqual(row(1));expect(f.controller.getSnapshot().messages).toBe(rows);
 f.controller.setReplyTarget(row(1).id);f.controller.setDraft('Reply');await f.controller.send();
 expect(f.post.mock.calls[0][0].url).toContain('/chat/replies');expect(await f.post.mock.calls[0][0].clone().json()).toEqual({membership_epoch:1,client_message_id:uuid(20),body:'Reply',reply_to_id:row(1).id});
 expect(f.controller.getSnapshot()).toMatchObject({draft:'',outgoing:{status:'sent',replyToId:row(1).id}});expect(f.controller.getSnapshot().replyTarget).toBeUndefined();expect(f.controller.getSnapshot().messages).toBe(rows);
});
it('unknown ACK keeps immutable target/text while new target/draft and navigation survive retry',async()=>{
 const f=fixture();await f.login();f.controller.setReplyTarget(row(250).id);f.controller.setDraft('original');f.post.mockRejectedValueOnce(Error());await f.controller.send();
 f.controller.setReplyTarget(row(249).id);f.controller.setDraft('new');await f.controller.loadOldest();await f.controller.send();
 expect(await f.post.mock.calls[0][0].clone().text()).toBe(await f.post.mock.calls[1][0].clone().text());
 expect(f.controller.getSnapshot()).toMatchObject({draft:'new',replyTarget:{id:row(249).id},outgoing:{replyToId:row(250).id,status:'sent'}});expect(f.controller.getSnapshot().messages[0]).toEqual(row(1));
});
it('target-only change during held ACK preserves composer; cancel leaves ordinary send unchanged',async()=>{
 const f=fixture();await f.login();f.controller.setDraft('same');f.controller.setReplyTarget(row(250).id);const hold=deferred();f.post.mockReturnValueOnce(hold.promise);const send=f.controller.send();await settle();
 f.controller.setReplyTarget(row(249).id);hold.resolve(envelope({replay:false,message:{...message(300),clientId:uuid(20),body:'same',replyToId:row(250).id}}));await send;
 expect(f.controller.getSnapshot()).toMatchObject({draft:'same',replyTarget:{id:row(249).id}});
 f.controller.cancelReply();await f.controller.send();expect(f.post.mock.calls[1][0].url).toContain('/chat/messages');expect(await f.post.mock.calls[1][0].clone().json()).not.toHaveProperty('reply_to_id');
});
it('detail late success/denial after close/newaccount cannot populate old text; samegeneration denial still blocks',async()=>{
 const f=fixture();await f.login();const hold=deferred();f.detail.mockReturnValueOnce(hold.promise);const load=f.controller.openReplyTarget(row(251).id);await settle();f.controller.closeReplyDetail();
 hold.resolve(envelope({message:message(1),readId:new URL(f.detail.mock.calls[0][0].url).searchParams.get('read_id')}));await load;expect(f.controller.getSnapshot().replyDetail).toBeUndefined();
 const late=deferred();f.detail.mockReturnValueOnce(late.promise);const load2=f.controller.openReplyTarget(row(251).id);await settle();await f.controller.signOut();await f.login();f.controller.setDraft('new');
 late.resolve(new Response(JSON.stringify({ok:false,error:'unavailable',readId:new URL(f.detail.mock.calls[1][0].url).searchParams.get('read_id')}),{status:403}));await load2;expect(f.controller.getSnapshot()).toMatchObject({phase:'signed_in',draft:'new'});
 f.detail.mockImplementationOnce(async r=>new Response(JSON.stringify({ok:false,error:'unavailable',readId:new URL(r.url).searchParams.get('read_id')}),{status:403}));await f.controller.openReplyTarget(row(251).id);expect(f.controller.getSnapshot().phase).toBe('blocked');
});
it('observed source tombstone clears preview, preserves unsent draft, refuses later live response including higher version',async()=>{
 const f=fixture();await f.login();await f.controller.openReplyTarget(row(251).id);f.controller.setReplyTarget(row(1).id);f.controller.setDraft('keep');
 const tombstone={...message(1),body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'};
 f.detail.mockImplementationOnce(async r=>envelope({message:tombstone,readId:new URL(r.url).searchParams.get('read_id')}));await f.controller.openReplyTarget(row(251).id);
 expect(f.controller.getSnapshot()).toMatchObject({draft:'keep',replyDetail:{body:null,version:2}});expect(f.controller.getSnapshot().replyTarget).toBeUndefined();f.controller.setReplyTarget(row(1).id);expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
 f.controller.closeReplyDetail();f.detail.mockImplementationOnce(async r=>envelope({message:{...message(1),version:99},readId:new URL(r.url).searchParams.get('read_id')}));await f.controller.openReplyTarget(row(251).id);expect(f.controller.getSnapshot().replyDetail).toBeUndefined();expect(f.controller.getSnapshot().error).toBe('invalid_response');
});
it('own reply tombstone before held ACK scrubs outgoing/queue and cannot restore old body; newer draft survives',async()=>{
 const f=fixture();await f.login();f.controller.setReplyTarget(row(250).id);f.controller.setDraft('senttext');const hold=deferred();f.post.mockReturnValueOnce(hold.promise);const sending=f.controller.send();await settle();f.controller.setDraft('new draft');
 const tombstone={...message(300),clientId:uuid(20),replyToId:row(250).id,body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'};
 f.history.mockImplementationOnce(async r=>envelope({messages:[tombstone],readId:new URL(r.url).searchParams.get('read_id'),hasOlder:false,hasNewer:false,olderCursor:null,newerCursor:null}));await f.controller.loadLatest();expect(f.controller.getSnapshot().outgoing).toBeUndefined();
 hold.resolve(envelope({replay:false,message:{...tombstone,body:'senttext',version:1,deletedAt:null}}));await sending;
 expect(f.controller.getSnapshot().outgoing).toBeUndefined();expect(f.controller.getSnapshot().draft).toBe('new draft');expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('senttext');
});
it('own tombstone immediately clears unchanged submitted composer before the held ACK arrives', async () => {
 const f = fixture();
 await f.login();
 f.controller.setReplyTarget(row(250).id);
 f.controller.setDraft('submitted body');
 const hold = deferred();
 f.post.mockReturnValueOnce(hold.promise);
 const sending = f.controller.send();
 await settle();
 const tombstone = { ...message(300), clientId: uuid(20), replyToId: row(250).id,
   body: null, version: 2, deletedAt: '2026-11-12T00:00:00.000Z' };
 f.history.mockImplementationOnce(async request => envelope({
   messages: [tombstone], readId: new URL(request.url).searchParams.get('read_id'),
   hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null,
 }));
 await f.controller.loadLatest();
 expect(f.controller.getSnapshot().draft).toBe('');
 expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
 expect(f.controller.getSnapshot().outgoing).toBeUndefined();
 expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('submitted body');
 hold.resolve(envelope({ replay: false,
   message: { ...tombstone, body: 'submitted body', version: 1, deletedAt: null } }));
 await sending;
 expect(f.controller.getSnapshot().draft).toBe('');
 expect(f.controller.getSnapshot().outgoing).toBeUndefined();
});
it('reply unavailable is definitive local refusal without logout or lost newer text',async()=>{
 const f=fixture();await f.login();f.controller.setReplyTarget(row(250).id);f.controller.setDraft('keep');f.post.mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error:'reply_unavailable'}),{status:409}));await f.controller.send();
 expect(f.controller.getSnapshot()).toMatchObject({phase:'signed_in',draft:'keep',error:'reply_unavailable'});expect(f.controller.getSnapshot().replyTarget).toBeUndefined();expect(f.controller.getSnapshot().outgoing).toBeUndefined();
 await f.controller.openReplyTarget(row(251).id);f.controller.setReplyTarget(row(1).id);
 f.detail.mockImplementationOnce(async r=>new Response(JSON.stringify({ok:false,error:'reply_unavailable',readId:new URL(r.url).searchParams.get('read_id')}),{status:409}));await f.controller.openReplyTarget(row(251).id);expect(f.controller.getSnapshot().replyTarget).toBeUndefined();expect(f.controller.getSnapshot().replyDetail).toBeUndefined();
});
it('no arbitrary detail fetch, signedout selection or cross-session pending reuse',async()=>{
 const f=fixture();f.controller.setReplyTarget(row(1).id);f.controller.cancelReply();await f.controller.openReplyTarget(row(1).id);await f.login();await f.controller.openReplyTarget(uuid(999));await f.controller.openReplyTarget(row(250).id);expect(f.detail).not.toHaveBeenCalled();
 f.controller.setReplyTarget(row(250).id);f.controller.setDraft('old');const hold=deferred();f.post.mockReturnValueOnce(hold.promise);const sending=f.controller.send();await settle();await f.controller.signOut();f.setContext({...context,userId:uuid(4)});await f.login();
 hold.resolve(envelope({replay:false,message:{...message(300),clientId:uuid(20),body:'old',replyToId:row(250).id}}));await sending;expect(f.controller.getSnapshot().outgoing).toBeUndefined();expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
});
it('opening a different original hides previous body immediately and unavailable never restores it',async()=>{
 const f=fixture();await f.login();await f.controller.openReplyTarget(row(251).id);expect(f.controller.getSnapshot().replyDetail?.body).toBe('Synthetic 1');
 const second={...message(250),replyToId:row(2).id};
 f.history.mockImplementationOnce(async r=>envelope({messages:[second,message(251)],readId:new URL(r.url).searchParams.get('read_id'),hasOlder:false,hasNewer:false,olderCursor:null,newerCursor:null}));
 // Use another fresh window with no conflicting known identity.
 f.controller.closeReplyDetail();await f.controller.signOut();
 f.history.mockImplementationOnce(async r=>envelope({messages:[second,message(251)],readId:new URL(r.url).searchParams.get('read_id'),hasOlder:false,hasNewer:false,olderCursor:null,newerCursor:null}));await f.login();await f.controller.openReplyTarget(row(251).id);
 const hold=deferred();f.detail.mockReturnValueOnce(hold.promise);const loading=f.controller.openReplyTarget(row(250).id);await settle();expect(f.controller.getSnapshot().replyDetail).toBeUndefined();
 hold.resolve(new Response(JSON.stringify({ok:false,error:'reply_unavailable',readId:new URL(f.detail.mock.calls.at(-1)![0].url).searchParams.get('read_id')}),{status:409}));await loading;expect(f.controller.getSnapshot().replyDetail).toBeUndefined();
});
it('detail nonce-bound stale membership invalidates current auth generation',async()=>{
 const f=fixture();await f.login();f.detail.mockImplementationOnce(async r=>new Response(JSON.stringify({ok:false,error:'stale_membership',readId:new URL(r.url).searchParams.get('read_id')}),{status:409}));await f.controller.openReplyTarget(row(251).id);expect(f.controller.getSnapshot().phase).toBe('blocked');
});
it('501 terminal IDs suspend safely without eviction; unrelated draft/pending survive but never display or send',async()=>{
 const f=fixture();await f.login();f.controller.setReplyTarget(row(250).id);f.controller.setDraft('unrelated pending');const hold=deferred();f.post.mockReturnValueOnce(hold.promise);const sending=f.controller.send();await settle();f.controller.setDraft('new private draft');
 for(let page=0;page<11;page++){
  const records=Array.from({length:page===10?1:50},(_,i)=>({...message(1000+page*50+i),body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'}));
  f.history.mockImplementationOnce(async r=>envelope({messages:records,readId:new URL(r.url).searchParams.get('read_id'),hasOlder:false,hasNewer:false,olderCursor:null,newerCursor:null}));await f.controller.loadLatest();
 }
 expect(f.controller.getSnapshot()).toMatchObject({chatSuspended:true,error:'tombstone_limit',messages:[],draft:'new private draft'});expect(f.controller.getSnapshot().outgoing).toBeUndefined();expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
 const requests=f.history.mock.calls.length;await f.controller.loadLatest();await f.controller.loadOldest();await f.controller.openReplyTarget(row(251).id);await f.controller.send();expect(f.history).toHaveBeenCalledTimes(requests);expect(f.post).toHaveBeenCalledTimes(1);
 hold.resolve(envelope({replay:false,message:{...message(300),clientId:uuid(20),body:'unrelated pending',replyToId:row(250).id}}));await sending;
 expect(f.controller.getSnapshot().outgoing).toBeUndefined();expect(f.controller.getSnapshot().draft).toBe('new private draft');
 await f.controller.signOut();await f.login();expect(f.controller.getSnapshot().chatSuspended).toBeUndefined();expect(f.controller.getSnapshot().draft).toBe('');
});

it('rejects an uppercase live UUID alias after its lowercase tombstone leaves the window', async () => {
 const f = fixture();
 await f.login();
 const id = 'abcdef00-0000-4000-8000-000000000001';
 const deleted = { ...message(300), id, body: null, version: 2,
   deletedAt: '2026-11-12T00:00:00.000Z' };
 const respond = (item: typeof deleted | ReturnType<typeof message>) => {
   f.history.mockImplementationOnce(async request => envelope({
     messages: [item], readId: new URL(request.url).searchParams.get('read_id'),
     hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null,
   }));
 };
 respond(deleted);
 await f.controller.loadLatest();
 expect(f.controller.getSnapshot().messages[0].body).toBeNull();
 await f.controller.loadOldest();
 expect(f.controller.getSnapshot().messages.some(item => item.id === id)).toBe(false);
 const oldWindow = f.controller.getSnapshot().messages;
 respond({ ...message(300), id: id.toUpperCase(), body: 'must not reappear' });
 await f.controller.loadLatest();
 expect(f.controller.getSnapshot().error).toBe('invalid_response');
 expect(f.controller.getSnapshot().messages).toBe(oldWindow);
 expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('must not reappear');
});
