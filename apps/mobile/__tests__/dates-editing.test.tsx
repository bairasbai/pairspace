import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DatesPanel } from '../src/auth/DatesPanel';
import { datesCopy } from '../src/auth/datesCopy';
import { fixture, ack, envelope, error, date, uuid, settle } from './dates-fixtures';
async function editing() {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ dates: [date], limit: 50 }));
  await f.api.list(); f.api.beginEdit(date.id); return f;
}
it('selects a date privately and explicitly submits full versioned partner edit', async () => {
  const f = await editing(); expect(f.operation).toHaveBeenCalledTimes(1);
  f.api.setDraft('Edited'); f.operation.mockResolvedValueOnce(ack({ ...date, title: 'Edited', version: 2, creatorId: uuid(8) }));
  await f.api.create(); const request = f.operation.mock.calls[1][0];
  expect(request.method).toBe('PATCH'); expect(request.url).toContain('/dates/' + date.id);
  expect(await request.json()).toMatchObject({ expected_version: 1, title: 'Edited', recurrence: 'once', leap_day_policy: null });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', editing: null, draft: '', dates: [{ version: 2, title: 'Edited' }] });
});
it('retains immutable edit target and payload after lost ACK, changed draft, cancel and selection attempt', async () => {
  const f = await editing(); f.api.setDraft('First'); f.operation.mockResolvedValueOnce(error('temporary', 503));
  await f.api.create(); f.api.beginEdit(uuid(8)); f.api.cancel(); f.api.setDraft('Later draft');
  f.operation.mockResolvedValueOnce(ack({ ...date, title: 'Partner changed later', version: 3 }, true)); await f.api.retry();
  expect(await f.operation.mock.calls[2][0].json()).toEqual(await f.operation.mock.calls[1][0].json());
  expect(f.api.getSnapshot()).toMatchObject({ draft: 'Later draft', editing: null, dates: [{ version: 3, title: 'Partner changed later' }], pending: null });
});
it('accepts canonical create historical replay and never replaces known newer date with older ACK', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  f.operation.mockResolvedValueOnce(envelope({ dates: [{ ...date, version: 4, title: 'Latest' }], limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...date, version: 3, title: 'Historical' }, true)); await f.api.retry();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', dates: [{ version: 4, title: 'Latest' }] });
});
it('preserves conflicted draft and requires explicit refresh and re-selection rather than silently rebasing', async () => {
  const f = await editing(); f.api.setDraft('My draft'); f.operation.mockResolvedValueOnce(error('version_conflict', 409)); await f.api.create();
  f.api.beginEdit(date.id); expect(f.api.getSnapshot().draft).toBe('My draft');
  f.operation.mockResolvedValueOnce(envelope({ dates: [{ ...date, version: 2, title: 'Partner' }], limit: 50 })); await f.api.list();
  expect(f.api.getSnapshot().draft).toBe('My draft'); await f.api.create(); expect(f.api.getSnapshot().status).toBe('conflict');
  f.operation.mockResolvedValueOnce(envelope({ dates: [{ ...date, version: 2, title: 'Partner' }], limit: 50 })); await f.api.list();
  f.api.beginEdit(date.id); expect(f.api.getSnapshot()).toMatchObject({ draft: 'Partner', editing: { version: 2 } });
});
it.each([{ version: 1 }, { id: uuid(90), version: 2 }, { version: 3 }, { version: 2, title: 'Wrong' }])('rejects mismatched non-replay edit ACK %p', async change => {
  const f = await editing(); f.operation.mockResolvedValueOnce(ack({ ...date, ...change })); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('ignores missing selection, busy selection and invalidated late edit response', async () => {
  const f = await editing(); f.api.beginEdit(uuid(90)); expect(f.api.getSnapshot().editing?.id).toBe(date.id);
  let release!: (value: Response) => void; f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.create(); await settle(); f.api.beginEdit(date.id); f.controller.reset(); f.api.beginEdit(date.id);
  release(ack({ ...date, version: 2 })); await work; expect(f.api.getSnapshot()).toMatchObject({ available: false, dates: [], editing: null });
});
it.each(['ru', 'en'] as const)('edit UI explicit consent, cancel and retry in %s', async locale => {
  const f = await editing(), t = datesCopy[locale];
  const props = { locale, view: f.api.getSnapshot(), onEdit: f.api.beginEdit, onDraft: f.api.setDraft,
    onLocalDate: f.api.setLocalDate, onTimezone: f.api.setTimezone, onRecurrence: f.api.setRecurrence,
    onLeapDayPolicy: f.api.setLeapDayPolicy, onCreate: () => { void f.api.create(); }, onRetry: () => { void f.api.retry(); },
    onList: () => { void f.api.list(); }, onCancel: f.api.cancel };
  const ui = render(<DatesPanel {...props} />); expect(screen.getByText(t.editNotice)).toBeTruthy();
  fireEvent.press(screen.getByText(t.edit)); expect(f.api.getSnapshot().editing?.id).toBe(date.id);
  f.operation.mockResolvedValueOnce(ack({ ...date, version: 2 }));
  await act(async () => { fireEvent.press(screen.getByText(t.saveEdit)); });
  expect(f.api.getSnapshot().status).toBe('saved'); ui.unmount();
});
it('edits schedule and zone while requiring a fresh explicit February 29 policy', async () => {
  const f = await editing(); f.api.setRecurrence('annual'); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('invalid'); expect(f.operation).toHaveBeenCalledTimes(1);
  f.api.setLeapDayPolicy('mar1'); f.api.setTimezone('America/Los_Angeles');
  f.operation.mockResolvedValueOnce(ack({ ...date, version: 2, recurrence: 'annual', leapDayPolicy: 'mar1', timezone: 'America/Los_Angeles' }));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('saved');
  expect(await f.operation.mock.calls[1][0].json()).toMatchObject({ expected_version: 1, recurrence: 'annual', leap_day_policy: 'mar1', timezone: 'America/Los_Angeles' });
});
it.each([undefined, 0, -1, 1.5, '1', 2147483648])('rejects invalid resource version %p', async version => {
  const f = fixture(); f.operation.mockResolvedValueOnce(ack({ ...date, version })); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
