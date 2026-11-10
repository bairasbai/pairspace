import { validRound } from '../src/auth/blind-state';
import { fixture, ack, round, envelope, context, uuid } from './blind-fixtures';
it.each([null, [], {}, { ...round, extra: true }, { ...round, id:'bad' }, { ...round, coupleId:uuid(90) },
  { ...round, membershipEpoch:2 }, { ...round, catalogVersion:2 }, { ...round, revealed:1 },
  { ...round, ownAnswer:'' }, { ...round, partnerAnswer:'hidden' }, { ...round, revealed:true, ownAnswer:'Mine',partnerAnswer:null },
  { ...round, revealed:true,ownAnswer:null,partnerAnswer:'Theirs' }])('strict round schema %p', value => expect(validRound(value,context)).toBe(false));
it('rejects unready context and accepts valid mutual reveal', () => {
  expect(validRound(round,{ state:'unmapped',sessionId:'session' })).toBe(false);
  expect(validRound({ ...round,ownAnswer:'Mine',partnerAnswer:'Theirs',revealed:true },context)).toBe(true);
});
it('never replaces an existing round, changes own immutable answer or retracts reveal', async () => {
  const f=fixture(); f.operation.mockResolvedValueOnce(ack({ ...round,ownAnswer:'Mine',partnerAnswer:'Theirs',revealed:true })); await f.api.open();
  for (const value of [{ ...round,ownAnswer:'Mine',partnerAnswer:'Changed partner answer',revealed:true },{ ...round,id:uuid(10) },{ ...round,ownAnswer:'Changed',partnerAnswer:'Theirs',revealed:true },{ ...round,ownAnswer:'Mine' }]) {
    f.operation.mockResolvedValueOnce(envelope({ round:value })); await f.api.read(); expect(f.api.getSnapshot().round?.partnerAnswer).toBe('Theirs');
  }
});
it('rejects answer ACK mismatches and malformed response variants', async () => {
  const f=fixture(); await f.api.open(); f.api.setConsent(true);
  for (const value of [{ round:{ ...round,ownAnswer:'Other' },commandId:uuid(3),replay:false },
    { round:{ ...round,id:uuid(12),ownAnswer:'Small joy' },commandId:uuid(3),replay:false },
    { round,commandId:uuid(3),replay:'yes' },null]) {
    f.operation.mockResolvedValueOnce(envelope(value));
    if (f.api.getSnapshot().pending) await f.api.retry(); else await f.api.submit();
    expect(f.api.getSnapshot().status).toBe('retry');
  }
});
it.each([3,4])('changed cookie on check %s scrubs all answer state', async check => {
  const f=fixture(); let calls=0;
  f.host.getCookie.mockImplementation(async () => ++calls >= check ? 'new' : 'old');
  await f.api.open(); expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot().round).toBeNull();
});
it('refresh while unknown ACK preserves pending command and only accepts canonical answer on replay', async () => {
  const f=fixture(); await f.api.open(); f.api.setConsent(true); f.operation.mockRejectedValueOnce(new Error('lost')); await f.api.submit();
  f.operation.mockResolvedValueOnce(envelope({ round:{ ...round,ownAnswer:'Small joy' } })); await f.api.read();
  expect(f.api.getSnapshot()).toMatchObject({ pending:'answer',status:'retry',draft:'' });
  f.operation.mockResolvedValueOnce(ack({ ...round,ownAnswer:'Small joy' },true)); await f.api.retry(); expect(f.api.getSnapshot().pending).toBeNull();
});
