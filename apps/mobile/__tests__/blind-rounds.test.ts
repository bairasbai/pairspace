import { fixture, round, ack, envelope, error, uuid, settle } from './blind-fixtures';
import { validWindow } from '../src/auth/blind-state';
const revealed = { ...round, ownAnswer: 'Joy', partnerAnswer: 'Walk', revealed: true };
const second = { ...round, id: uuid(10), questionId: 'shared-plan' };
const summary = (r: typeof round) => ({ id: r.id, questionId: r.questionId, catalogVersion: r.catalogVersion });
const window = (items = [round]) => ({ currentRoundId: items[0]?.id ?? null, rounds: items.map(summary), limit: 10 });
async function ready() {
  const f = fixture(); f.operation.mockResolvedValueOnce(ack(revealed)); await f.api.open();
  f.operation.mockResolvedValueOnce(envelope(window())); await f.api.listRounds(); return f;
}
it('loads only metadata explicitly and confirms a chosen next question, clears draft and enables later next', async () => {
  const f = await ready(); const count = f.operation.mock.calls.length;
  await f.api.next('shared-plan', 1, false); await f.api.next('unknown', 1, true);
  expect(f.operation).toHaveBeenCalledTimes(count);
  f.operation.mockResolvedValueOnce(ack(second)); await f.api.next('shared-plan', 1, true);
  expect(f.api.getSnapshot()).toMatchObject({ round: second, currentRoundId: null, draft: '', consent: false });
  expect(await f.operation.mock.calls[count][0].json()).toMatchObject({ question_id:'shared-plan', catalog_version:1, expected_predecessor_round_id:round.id, confirm:true });
  f.operation.mockResolvedValueOnce(envelope(window([second,round]))); await f.api.listRounds();
  f.api.setDraft('Plan'); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(ack({ ...second, ownAnswer:'Plan' })); await f.api.submit();
  expect(await f.operation.mock.calls[count+2][0].json()).toMatchObject({ question_id:'shared-plan',answer:'Plan' });
});
it('retains unresolved next on predecessor; selection invalidates late ACK and retries exact command', async () => {
  const f = await ready(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const request = f.api.next('shared-plan',1,true); await settle();
  // Metadata may contain another already opened round after a prior explicit refresh.
  f.operation.mockResolvedValueOnce(envelope({ round: revealed })); await f.api.selectRound(round.id);
  release(ack(second)); await request; expect(f.api.getSnapshot().round?.id).toBe(round.id);
  expect(f.api.getSnapshot().pending).toBe('next');
  f.operation.mockResolvedValueOnce(ack(second,true)); await f.api.retry();
  expect(await f.operation.mock.calls[2][0].json()).toEqual(await f.operation.mock.calls[4][0].json());
  expect(f.api.getSnapshot().round?.id).toBe(second.id);
});
it('history is read-only; switching clears drafts, late responses cannot replace selection', async () => {
  const f = fixture(); await f.api.open(); f.api.setDraft('discard'); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(envelope(window([second,round]))); await f.api.listRounds();
  f.operation.mockResolvedValueOnce(envelope({ round: second })); await f.api.selectRound(second.id);
  expect(f.api.getSnapshot()).toMatchObject({ draft:'', consent:false });
  f.api.setDraft('new draft');
  f.operation.mockResolvedValueOnce(envelope({ round })); await f.api.selectRound(round.id);
  f.api.setDraft('historical'); f.api.setConsent(true); await f.api.submit(); await f.api.next('shared-plan',1,true);
  expect(f.api.getSnapshot().draft).toBe('');
  await f.api.selectRound(uuid(99));
  f.operation.mockResolvedValueOnce(envelope({ round: second })); await f.api.read();
  expect(f.api.getSnapshot().round?.id).toBe(round.id);
});
it.each([round, { ...second, questionId:'kind-memory' }])('rejects mismatched next ACK %p', async result => {
  const f=await ready(); f.operation.mockResolvedValueOnce(ack(result)); await f.api.next('shared-plan',1,true);
  expect(f.api.getSnapshot()).toMatchObject({ pending:'next', status:'retry', round:revealed });
});
it('next conflict requires refresh and rejects malformed metadata without private content',async()=>{
  const f=await ready(); f.operation.mockResolvedValueOnce(error('round_conflict',409)); await f.api.next('shared-plan',1,true);
  expect(f.api.getSnapshot().requiresRefresh).toBe(true);
  f.operation.mockResolvedValueOnce(envelope({ ...window(), rounds:[{ ...summary(round),ownAnswer:'private' }] }));
  await f.api.listRounds(); expect(f.api.getSnapshot().rounds).toEqual([summary(round)]);
});
it.each([null,{}, { ...window(),limit:11 }, { ...window(), rounds:Array(11).fill(summary(round)) },
  { ...window(), rounds:[summary(round),summary(round)] }, { ...window(),currentRoundId:uuid(99) },
  { ...window(),rounds:[{...summary(round),questionId:'unknown'}] }, { ...window(),extra:true },
  { ...window(),rounds:[{...summary(round),catalogVersion:'1'}] }, { ...window(),rounds:[null] }])('rejects unsafe window %p',value=>expect(validWindow(value)).toBe(false));
it('validates empty and latest-ten window',()=>{ expect(validWindow(window([]))).toBe(true);expect(validWindow(window())).toBe(true); });
it('rejects catalog mutation on known read and answer ACK even without metadata',async()=>{
  const f=fixture(); await f.api.open();
  f.operation.mockResolvedValueOnce(envelope({round:{...round,questionId:'shared-plan'}})); await f.api.read();
  expect(f.api.getSnapshot().round?.questionId).toBe('small-joy');
  f.api.setConsent(true);f.operation.mockResolvedValueOnce(ack({...round,questionId:'shared-plan',ownAnswer:'Small joy'}));
  await f.api.submit();expect(f.api.getSnapshot()).toMatchObject({pending:'answer',status:'retry'});
});
it('rejects metadata catalog mutation for a known round',async()=>{
  const f=fixture();await f.api.open();
  f.operation.mockResolvedValueOnce(envelope(window([{...round,questionId:'shared-plan'}])));await f.api.listRounds();
  expect(f.api.getSnapshot()).toMatchObject({rounds:[],error:true});
});
