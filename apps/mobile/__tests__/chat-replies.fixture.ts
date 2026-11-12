import { createSessionController } from '../src/auth/controller';
import { context, identity, row, uuid, envelope, windowResponse, settle, deferred } from './chat-window.fixture';
export { context, identity, row, uuid, envelope, settle, deferred };
export const message = (n:number) => ({ ...row(n), replyToId: n === 251 ? row(1).id : null, deletedAt: null as string|null });
export function fixture() {
  let current=context;
  const client={signIn:jest.fn(async()=>identity),signOut:jest.fn(async()=>true),getCookie:jest.fn(async()=>'test=cookie')};
  const discovery=jest.fn(async()=>envelope(current));
  const history=jest.fn(async(r:Request)=>{const json=await windowResponse(r).json();json.value.messages=json.value.messages.map((m:ReturnType<typeof row>)=>message(m.seq/3));return envelope(json.value);});
  const detail=jest.fn(async(r:Request)=>{const u=new URL(r.url);const id=u.searchParams.get('message_id');const n=Number(id?.slice(-12))-1000;return envelope({message:message(n),readId:u.searchParams.get('read_id')});});
  const post=jest.fn(async(r:Request)=>{const body=await r.clone().json();return envelope({replay:false,message:{...row(300),senderId:current.userId,clientId:body.client_message_id,body:body.body,...(r.url.endsWith('/replies')?{replyToId:body.reply_to_id,deletedAt:null}:{})}});});
  const remove=jest.fn(async(r:Request)=>{const body=await r.clone().json();const id=new URL(r.url).pathname.split('/').at(-1)!;const n=Number(id.slice(-12))-1000;return envelope({commandId:body.command_id,replay:false,message:{...message(n),body:null,version:body.expected_version+1,deletedAt:'2026-11-12T00:00:00.000Z'}});});
  let command=20;
  const controller=createSessionController({mode:'synthetic-loopback',baseURL:'http://localhost:8787'},client,r=>r.url.endsWith('/context')?discovery():r.method==='DELETE'?remove(r):r.method==='POST'?post(r):r.url.includes('/message-detail?')?detail(r):history(r),()=>uuid(command++));
  return{controller,client,discovery,history,detail,post,remove,setContext:(c:typeof context)=>{current=c;},login:()=>controller.signIn('a@example.test','test')};
}
