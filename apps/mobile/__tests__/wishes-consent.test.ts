import { fixture, ack, envelope, error, wish, settle, context, uuid } from './wishes-fixtures';
import { normalizeWishExplanation } from '../../../packages/domain/wishes/text';

it('requires explicit publication consent and revokes it on either draft change', async () => {
  const f = fixture(); f.api.setConsent(false); await f.api.create();
  expect(f.operation).not.toHaveBeenCalled();
  f.api.setConsent(true); f.api.setExplanation('For us'); await f.api.create();
  expect(f.operation).not.toHaveBeenCalled();
  f.api.setConsent(true); f.api.setDraft(wish.title); await f.api.create();
  expect(f.operation).not.toHaveBeenCalled();
  f.api.setConsent(true); f.operation.mockResolvedValueOnce(ack({ ...wish, explanation: 'For us' }));
  await f.api.create();
  expect(await f.operation.mock.calls[0][0].json()).toMatchObject({ explanation: 'For us' });
  expect(f.api.getSnapshot()).toMatchObject({ draft: '', explanation: '', consent: false });
});
it('keeps original explanation through unknown ACK while preserving newer consented draft', async () => {
  const f = fixture(); f.api.setExplanation('Original'); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  expect(f.api.getSnapshot().pending).toMatchObject({ explanation: 'Original' });
  f.api.setExplanation('Later'); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(ack({ ...wish, explanation: 'Original' }, 1, true));
  await f.api.retry();
  expect(await f.operation.mock.calls[1][0].json()).toMatchObject({ explanation: 'Original' });
  expect(f.api.getSnapshot()).toMatchObject({ explanation: 'Later', consent: true });
});
it('does not regress canonical state observed on refresh before replay', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ wishes: [wish], limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.fulfill(wish.id);
  f.operation.mockResolvedValueOnce(envelope({ wishes: [{ ...wish, version: 3 }], limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...wish, version: 2, state: 'fulfilled' }, 2, true)); await f.api.retry();
  expect(f.api.getSnapshot().wishes[0]).toMatchObject({ version: 3, state: 'open' });
});
it('scrubs explanation and consent on epoch change and ignores old ACK', async () => {
  const f = fixture(); f.api.setExplanation('Old pair'); f.api.setConsent(true);
  let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.create(); await settle();
  f.set({ generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context: { ...context, membershipEpoch: 2 } });
  f.controller.sync(); release(ack({ ...wish, explanation: 'Old pair' })); await work;
  expect(f.api.getSnapshot()).toMatchObject({ explanation: '', consent: false, wishes: [], pending: null });
});
it.each(['x'.repeat(601), '\u0000', '\u200b', '\uD800', 'x'.repeat(1201)])('rejects invalid explanation %p', async explanation => {
  const f = fixture(); f.api.setExplanation(explanation); f.api.setConsent(true); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('invalid'); expect(f.operation).not.toHaveBeenCalled();
});
it('normalizes optional explanation, Unicode and newline boundaries', () => {
  expect(normalizeWishExplanation('')).toEqual({ ok: true, text: '' });
  expect(normalizeWishExplanation(null)).toEqual({ ok: false });
  expect(normalizeWishExplanation('  Cafe\u0301\r\nTogether  ')).toEqual({ ok: true, text: 'Café\nTogether' });
  expect(normalizeWishExplanation('😀'.repeat(600))).toEqual({ ok: true, text: '😀'.repeat(600) });
});
it('refuses mismatched immutable explanation and excessive version in ACK', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(ack({ ...wish, explanation: 'Other' })); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(ack({ ...wish, version: 2147483648 }, 1, true)); await f.api.retry();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('bounds explanation RAM and keeps unavailable setters inert', () => {
  const f = fixture(); f.api.setExplanation('x'.repeat(5000)); expect(f.api.getSnapshot().explanation).toHaveLength(1201);
  f.controller.reset(); f.api.setExplanation('No'); f.api.setConsent(true);
  expect(f.api.getSnapshot()).toMatchObject({ explanation: '', consent: false });
});
it('does not submit a transition at the maximum server version', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ wishes: [{ ...wish, version: 2147483647 }], limit: 50 }));
  await f.api.list(); await f.api.fulfill(wish.id); expect(f.command).not.toHaveBeenCalled();
});
it.each([{ value: { wish, appliedVersion: 1, replay: false, commandId: uuid(3), extra: true } },
  { extra: true, value: { wish, appliedVersion: 1, replay: false, commandId: uuid(3) } }])('rejects extra envelope fields', async changes => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ...changes })));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
