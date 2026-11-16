import { expect,it } from 'vitest';
import { followsCapsule,type Capsule } from '../../../packages/domain/capsules/policy.ts';
const scope={userId:'11111111-1111-4111-8111-111111111111',coupleId:'22222222-2222-4222-8222-222222222222',membershipEpoch:1};
const q:Capsule={id:'33333333-3333-4333-8333-333333333333',authorId:scope.userId,coupleId:scope.coupleId,membershipEpoch:1,version:1,
 createdAt:'2026-11-10T00:00:00.000Z',sealedAt:'2026-11-10T00:00:00.000Z',releaseAt:'2026-11-11T06:00:00.000Z',localDate:'2026-11-11',localTime:'09:00',timezone:'Europe/Moscow',offset:'+03:00',contentState:'active'};
it('receipt monotonicity checks fixed identity, exact snapshots, terminal state and possible intervening reseals',()=>{
 expect(followsCapsule(q,q,scope)).toBe(true);
 for(const bad of [null,{},{...q,text:'hidden'}]){expect(followsCapsule(bad,q,scope)).toBe(false);expect(followsCapsule(q,bad,scope)).toBe(false);}
 expect(followsCapsule(q,{...q,id:'44444444-4444-4444-8444-444444444444'},scope)).toBe(false);
 expect(followsCapsule({...q,version:2},q,scope)).toBe(false);
 expect(followsCapsule({...q,version:2,sealedAt:'2026-11-10T01:00:00.000Z'},{...q,version:3},scope)).toBe(false);
 const shifted={...q,localTime:'10:00',releaseAt:'2026-11-11T07:00:00.000Z'};expect(followsCapsule(q,shifted,scope)).toBe(false);
 const removed={...q,version:2,contentState:'removed' as const};expect(followsCapsule(q,removed,scope)).toBe(true);expect(followsCapsule(removed,removed,scope)).toBe(true);
 expect(followsCapsule(removed,{...removed,version:3},scope)).toBe(false);
 expect(followsCapsule(q,{...shifted,version:2,contentState:'removed'},scope)).toBe(false);
 expect(followsCapsule(q,{...q,version:2},scope)).toBe(true);
 const after={...q,version:2,sealedAt:q.releaseAt,localDate:'2026-11-13',releaseAt:'2026-11-13T06:00:00.000Z'};
 expect(followsCapsule(q,after,scope)).toBe(false);expect(followsCapsule(q,{...after,version:3},scope)).toBe(true);
 expect(followsCapsule(q,{...after,version:3,contentState:'removed'},scope)).toBe(false);
 expect(followsCapsule(q,{...after,version:3,contentState:'removed',sealedAt:'2026-11-11T05:59:59.999Z'},scope)).toBe(true);
 expect(followsCapsule(q,{...after,version:4,contentState:'removed'},scope)).toBe(true);
});
