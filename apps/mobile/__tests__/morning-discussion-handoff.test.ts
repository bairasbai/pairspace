import { fixture, deferred, envelope, slot, id } from './mornings.fixture';
const anchor = () => ({ ...slot(900), prepared: true, state: 'available' as const });
it('recovers an off-page discussion slot through GET only, without widening generic open', async () => {
  const f = fixture(), a = f.actions;
  await a.open(id(900)); expect(f.read).not.toHaveBeenCalled();
  f.read.mockImplementationOnce(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'),
    serverNow: '2030-01-02T10:00:00.000Z', slot: anchor(), body: 'original letter' }));
  expect(await a.openDiscussionSlot(anchor())).toEqual(anchor());
  expect(a.getSnapshot().opened?.body).toBe('original letter');
  expect(f.write).not.toHaveBeenCalled();
});
it('held saved A body GET cannot publish after selection B or close; no stuck busy', async () => {
  const f = fixture(), a = f.actions;
  await a.list(); const held = deferred(); f.read.mockImplementationOnce(() => held.promise);
  const opening = a.openDiscussionSlot(anchor());
  while (f.read.mock.calls.length < 2) await Promise.resolve();
  const nonce = new URL(f.read.mock.calls[1][0].url).searchParams.get('read_id');
  a.selectSlot(id(11)); a.setDraft('B draft');
  held.resolve(envelope({ readId: nonce, serverNow: '2030-01-02T10:00:00.000Z', slot: anchor(), body: 'A hidden late' }));
  await opening;
  expect(a.getSnapshot()).toMatchObject({ opened: null, busy: false, selected: { id: id(11) }, draft: 'B draft' });
  await a.openDiscussionSlot({ ...anchor(), state: 'sealed' });
  expect(f.read).toHaveBeenCalledTimes(2);
});

it('same-ID cancel and new handoff cannot make the obsolete caller open a discussion', async () => {
  const f = fixture(), a = f.actions, held = deferred();
  f.read.mockImplementationOnce(() => held.promise);
  const discuss = jest.fn();
  const old = a.openDiscussionSlot(anchor()).then(result => { if (result) discuss(result); return result; });
  while (!f.read.mock.calls.length) await Promise.resolve();
  const oldNonce = new URL(f.read.mock.calls[0][0].url).searchParams.get('read_id');
  a.close();
  f.read.mockImplementationOnce(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'),
    serverNow: '2030-01-02T10:00:00.000Z', slot: anchor(), body: 'fresh A' }));
  expect(await a.openDiscussionSlot(anchor())).toEqual(anchor());
  expect(a.getSnapshot().opened?.body).toBe('fresh A');
  held.resolve(envelope({ readId: oldNonce, serverNow: '2030-01-02T10:00:00.000Z', slot: anchor(), body: 'obsolete A' }));
  expect(await old).toBeNull();
  expect(discuss).not.toHaveBeenCalled();
  expect(a.getSnapshot().opened?.body).toBe('fresh A');
});
