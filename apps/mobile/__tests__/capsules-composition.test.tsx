import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectedTogether } from '../src/auth/ConnectedTogether';
import { createPairFeatures } from '../src/auth/pair-features';
import { fixture } from './predictions-fixtures';

it.each(['ru', 'en'] as const)('composes personal capsule with explicit loading and scope/unmount scrub %s', locale => {
  const f = fixture(), request = jest.fn(async () => { throw Error('Navigation must not fetch'); });
  const host = { ...f.host, suspend: jest.fn(), finish: jest.fn(async () => {}) };
  const features = createPairFeatures({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, host, request, () => 'command');
  features.sync();
  const controller = features.actions.capsules;
  expect(controller.getSnapshot().available).toBe(true);
  const title = locale === 'ru' ? 'Личная капсула' : 'Personal capsule';
  const view = render(<ConnectedTogether controller={features.actions} locale={locale}/>);
  fireEvent.press(screen.getByRole('tab', { name: title }));
  act(() => controller.setDraft('Synthetic private draft'));
  fireEvent.press(screen.getByRole('tab', { name: locale === 'ru' ? 'Словарь' : 'Dictionary' }));
  expect(controller.getSnapshot().draft).toBe(''); expect(controller.getSnapshot().reader).toBeNull();
  fireEvent.press(screen.getByRole('tab', { name: title }));
  view.rerender(<ConnectedTogether controller={{ ...features.actions, capsules: undefined }} locale={locale}/>);
  expect(screen.queryByRole('tab', { name: title })).toBeNull();
  expect(screen.getByRole('tab', { name: locale === 'ru' ? 'Словарь' : 'Dictionary' }).props.accessibilityState.selected).toBe(true);
  act(() => controller.setDraft('Synthetic local draft'));
  act(() => features.resetOrdinary()); expect(controller.getSnapshot().draft).toBe('');
  f.set(null); act(() => features.sync()); expect(controller.getSnapshot().available).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
