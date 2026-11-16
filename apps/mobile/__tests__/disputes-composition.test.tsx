import { fixture as disputeFixture, incoming, detail, ack, before } from './disputes-fixtures';
import { DisputesPanel } from '../src/auth/DisputesPanel';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectedTogether } from '../src/auth/ConnectedTogether';
import { createPairFeatures } from '../src/auth/pair-features';
import { fixture } from './predictions-fixtures';

it.each(['ru', 'en'] as const)('composes dispute with explicit loading and scope/unmount scrub %s', locale => {
  const f = fixture(), request = jest.fn(async () => { throw Error('Navigation must not fetch'); });
  const host = { ...f.host, suspend: jest.fn(), finish: jest.fn(async () => {}) };
  const features = createPairFeatures({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, host, request, () => 'command');
  features.sync();
  const controller = features.actions.disputes;
  expect(controller.getSnapshot().available).toBe(true);
  const title = locale === 'ru' ? 'Спор' : 'Disagreement';
  const view = render(<ConnectedTogether controller={features.actions} locale={locale}/>);
  fireEvent.press(screen.getByRole('tab', { name: title }));
  act(() => controller.setClaim('Synthetic private draft'));
  fireEvent.press(screen.getByRole('tab', { name: locale === 'ru' ? 'Словарь' : 'Dictionary' }));
  expect(controller.getSnapshot().draftClaim).toBe(''); expect(controller.getSnapshot().reader).toBeNull();
  fireEvent.press(screen.getByRole('tab', { name: title }));
  view.rerender(<ConnectedTogether controller={{ ...features.actions, disputes: undefined }} locale={locale}/>);
  expect(screen.queryByRole('tab', { name: title })).toBeNull();
  expect(screen.getByRole('tab', { name: locale === 'ru' ? 'Словарь' : 'Dictionary' }).props.accessibilityState.selected).toBe(true);
  act(() => controller.setClaim('Synthetic local draft'));
  act(() => features.resetOrdinary()); expect(controller.getSnapshot().draftClaim).toBe('');
  f.set(null); act(() => features.sync()); expect(controller.getSnapshot().available).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

it('real controller explicit reading enables consent without falsely certifying complete history', async () => {
  const f = disputeFixture(); await f.load([incoming]);
  render(<DisputesPanel controller={f.api} locale="en"/>);
  expect(screen.getByRole('button', { name: 'Voluntarily join' })).toBeDisabled();
  f.operation.mockResolvedValueOnce(detail(incoming));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Read terms' })); });
  expect(f.api.getSnapshot().checked).toBe(false);
  expect(screen.getByRole('button', { name: 'Voluntarily join' })).toBeEnabled();
  f.operation.mockResolvedValueOnce(ack({ ...incoming, version: 2, decisionState: 'joined', joinedAt: before }));
  fireEvent.press(screen.getByRole('button', { name: 'Voluntarily join' }));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Confirm' })); });
  expect(f.api.getSnapshot().disputes[0].decisionState).toBe('joined');
  expect(f.api.getSnapshot().reader).toBeNull();
});
