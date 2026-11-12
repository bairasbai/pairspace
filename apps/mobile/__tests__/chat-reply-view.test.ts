import { createReplyKnowledge, displayMessage, selectReply, consistentReply } from '../src/chat/reply-view';
import { createQueue, enqueue, beginSend, acknowledge, deleteConfirmed } from '../src/chat/queue';
import { row, uuid } from './chat-window.fixture';
const live = () => displayMessage({ ...row(1), replyToId: null, deletedAt: null });
const dead = () => ({ ...live(), body: null, version: 2, deletedAt: '2026-11-12T00:00:00.000Z' });
it('normalizes plain shape, keeps link only, previews90scalars and rejects deleted selection', () => {
  expect(live()).toEqual(row(1)); expect(displayMessage({ ...row(2), replyToId: uuid(10), deletedAt: null }).replyToId).toBe(uuid(10));
  expect(selectReply({ ...live(), body: '🌻'.repeat(100) }).preview).toBe('🌻'.repeat(90)); expect(() => selectReply(dead())).toThrow();
});
it('terminal knowledge survives leaving windows, no body resurrection or identity drift; transactions atomic', () => {
  const k = createReplyKnowledge(); expect(k.accept([dead()],[live()])).toBe(true); expect(k.tombstone(live().id)).toEqual(dead());
  expect(k.accept([live()],[])).toBe(false); expect(k.accept([{ ...live(), version: 99 }],[])).toBe(false);
  expect(k.accept([{ ...dead(), deletedAt: '2026-11-13T00:00:00.000Z' }],[])).toBe(false);
  expect(k.accept([{...dead(),version:3}],[])).toBe(true);
  const next = { ...dead(), id: uuid(100), seq: 100, clientId: uuid(200) };
  expect(k.accept([next,live()],[])).toBe(false); expect(k.tombstone(next.id)).toBeUndefined();
  k.reset(); expect(k.accept([live()],[])).toBe(true);
});
it('all immutable identity and live-version conflicts fail, terminal version must advance', () => {
  for (const patch of [{ id: uuid(9) },{coupleId:uuid(9)},{seq:99},{senderId:uuid(9)},{clientId:uuid(9)}, {createdAt:'2026-12-01T00:00:00Z'},{replyToId:uuid(9)},{body:'different'},{version:2}]) expect(consistentReply(live(),{...live(),...patch})).toBe(false);
  expect(consistentReply(live(),{...dead(),version:1})).toBe(false);
  const k=createReplyKnowledge(); expect(k.accept([{...row(2),seq:live().seq}],[live()])).toBe(false);
  expect(k.accept([{...row(2),clientId:live().clientId}],[live()])).toBe(false);
});
it('501st tombstone never evicts first; reset is explicit authentication boundary', () => {
  const k=createReplyKnowledge();
  for(let i=1;i<=500;i++)expect(k.accept([{...row(i),body:null,version:2,deletedAt:dead().deletedAt}],[])).toBe(true);
  expect(()=>k.accept([{...row(501),body:null,version:2,deletedAt:dead().deletedAt}],[])).toThrow('tombstone_limit');
  expect(k.tombstone(row(1).id)).toBeDefined(); expect(k.tombstone(row(501).id)).toBeUndefined();
});
it('queue binds target without copied sourcebody; ACK target mismatch and samekey retarget rejected', () => {
  const scope={userId:uuid(1),coupleId:uuid(2),membershipEpoch:1,sessionId:'s'};let q=createQueue(scope);
  const en=enqueue(q,scope,'client','reply',uuid(8));if(!en.ok)throw Error();q=en.state;
  expect(enqueue(q,scope,'client','reply',uuid(9)).ok).toBe(false);expect(enqueue(q,scope,'client','reply').ok).toBe(false);expect(enqueue(q,scope,'client','reply',uuid(8)).ok).toBe(true);
  expect(enqueue(q,scope,'bad','body','').ok).toBe(false);
  const started=beginSend(q,scope,'client');if(!started.ok)throw Error();q=started.state;
  const ack={clientId:'client',serverId:uuid(50),senderId:uuid(1),seq:1,version:1,body:'reply'};
  expect(acknowledge(q,scope,ack).ok).toBe(false);
  const accepted=acknowledge(q,scope,{...ack,replyToId:uuid(8)});if(!accepted.ok)throw Error();q=accepted.state;
  const deleted=deleteConfirmed(q,scope,'client',uuid(50),2);if(!deleted.ok)throw Error();q=deleted.state;
  const late=acknowledge(q,scope,{...ack,replyToId:uuid(8)});expect(late.ok).toBe(true);expect(late.state.messages[0].body).toBeNull();
});
