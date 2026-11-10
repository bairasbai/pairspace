import { validatedTimezone, isLocalDate } from '../../../packages/domain/dates/calendar';
import { fixture, ack, error, date, envelope, context, uuid, settle } from './dates-fixtures';
import { validDate } from '../src/auth/dates-state';
it.each([null, 1, '', '0000-01-01', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32',
  '2026-04-31', '2026-02-29', '1900-02-29', '2026-2-01', '10000-01-01', '2026-01-01Z'])('rejects invalid Gregorian label %p', value => {
  expect(isLocalDate(value)).toBe(false);
});
it.each(['0001-01-01', '9999-12-31', '2000-02-29', '2028-02-29', '2026-02-28', '2026-04-30'])('accepts Gregorian label %s', value => {
  expect(isLocalDate(value)).toBe(true);
});
it.each([null, 42, '', 'x'.repeat(101), '+09:00', 'UTC+9', 'Bad/Place', ' Asia/Tokyo'])('rejects non-IANA or unsupported zone %p', value => {
  expect(validatedTimezone(value)).toBeNull();
});
it('preserves exact recognized zone spelling and treats aliases as distinct immutable payloads', async () => {
  expect(validatedTimezone('US/Pacific')).toBe('US/Pacific');
  expect(validatedTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
  const f = fixture(); f.api.setTimezone('US/Pacific');
  f.operation.mockResolvedValueOnce(ack({ ...date, timezone: 'America/Los_Angeles' })); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
  expect(f.api.getSnapshot().pending?.timezone).toBe('US/Pacific');
  f.operation.mockResolvedValueOnce(ack({ ...date, timezone: 'US/Pacific' })); await f.api.retry();
  expect(f.api.getSnapshot().status).toBe('saved');
  expect(f.api.getSnapshot().dates[0].timezone).toBe('US/Pacific');
  expect(await f.operation.mock.calls[0][0].clone().json()).toMatchObject({ timezone: 'US/Pacific' });
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());
  expect(validDate({ ...date, timezone: 'US/Pacific' }, context)).toBe(true);
});
it('retries exact zone payload even when Intl canonical spelling changes between attempts', async () => {
  const f = fixture(); f.api.setTimezone('US/Pacific');
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  const canonical = jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...original.call(this), timeZone: 'America/Los_Angeles' };
  });
  try {
    f.api.setTimezone('Asia/Tokyo');
    f.operation.mockResolvedValueOnce(ack({ ...date, timezone: 'US/Pacific' })); await f.api.retry();
    expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());
    expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', timezone: 'Asia/Tokyo' });
  } finally { canonical.mockRestore(); }
});
it.each(['Asia/Tokyo', 'America/Los_Angeles'])('keeps all-day/DST calendar labels unchanged in %s', async timezone => {
  for (const localDate of ['2026-03-08', '2026-11-01', '2028-02-29', '0001-01-01', '9999-12-31']) {
    const f = fixture(); f.api.setLocalDate(localDate); f.api.setTimezone(timezone);
    f.operation.mockResolvedValue(ack({ ...date, localDate, timezone })); await f.api.create();
    expect(await f.operation.mock.calls[0][0].json()).toMatchObject({ local_date: localDate, timezone });
    expect(f.api.getSnapshot().dates[0].localDate).toBe(localDate);
  }
});
it('retains all three unknown command fields unchanged while a new draft is edited', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  f.api.setDraft('Another date'); f.api.setLocalDate('2030-01-01'); f.api.setTimezone('America/Los_Angeles');
  expect(f.api.getSnapshot().pending).toEqual({ title: date.title, localDate: date.localDate, timezone: date.timezone });
  await f.api.retry();
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());
  expect(f.api.getSnapshot()).toMatchObject({ draft: 'Another date', localDate: '2030-01-01', timezone: 'America/Los_Angeles', status: 'saved' });
});
it.each(['date', 'zone'])('rejects invalid %s before sending', async field => {
  const f = fixture();
  if (field === 'date') f.api.setLocalDate('2026-02-29'); else f.api.setTimezone('Bad/Place');
  await f.api.create(); expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe('invalid');
});
it('bounds draft fields and ignores edits after reset', () => {
  const f = fixture(); f.api.setLocalDate('x'.repeat(100)); f.api.setTimezone('x'.repeat(200));
  expect(f.api.getSnapshot().localDate).toHaveLength(10); expect(f.api.getSnapshot().timezone).toHaveLength(100);
  f.controller.reset(); f.api.setLocalDate(date.localDate); f.api.setTimezone(date.timezone);
  expect(f.api.getSnapshot()).toMatchObject({ localDate: '', timezone: '' });
});
it.each(['generation', 'identity', 'coupleId', 'membershipEpoch', 'sessionId', 'userId'])('does not accept late payload after %s drift', async field => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; })); const work = f.api.create(); await settle();
  const snapshot = f.host.capture()!;
  f.set(field === 'generation' ? { ...snapshot, generation: 2 } : field === 'identity' ? { ...snapshot, identity: { ...snapshot.identity } }
    : { ...snapshot, context: { ...context, [field]: field === 'membershipEpoch' ? 2 : uuid(77) } });
  f.controller.sync(); release(ack()); await work;
  expect(f.api.getSnapshot()).toMatchObject({ dates: [], pending: null, draft: '', localDate: '', timezone: '' });
});
it('partner-created dates are readable without changing calendar labels', async () => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ dates: [{ ...date, creatorId: uuid(4) }], limit: 50 }));
  await f.api.list(); expect(f.api.getSnapshot().dates[0].creatorId).toBe(uuid(4));
});
