import { act, render } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';
import { HeartButton } from '../src/HeartButton';

const props = { label: 'Care', hint: 'Preview', onPress: jest.fn() };
afterEach(() => jest.restoreAllMocks());

it('animates only when allowed and stops after a settings change and unmount', async () => {
  let listener: (value: boolean) => void = () => {};
  const remove = jest.fn();
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_event, callback) => {
    listener = callback; return { remove };
  });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const start = jest.fn(); const stop = jest.fn();
  jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: jest.fn() });
  const view = render(<HeartButton {...props} />);
  await act(async () => {});
  expect(start).toHaveBeenCalledTimes(1);
  act(() => listener(true));
  expect(stop).toHaveBeenCalledTimes(1);
  act(() => listener(false));
  expect(start).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(remove).toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(2);
  act(() => listener(true));
});

it('does not overwrite a newer accessibility event with an older query', async () => {
  let listener: (value: boolean) => void = () => {};
  let resolve!: (value: boolean) => void;
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_event, callback) => {
    listener = callback; return { remove: jest.fn() };
  });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(done => { resolve = done; }));
  const loop = jest.spyOn(Animated, 'loop');
  render(<HeartButton {...props} />);
  act(() => listener(true));
  await act(async () => resolve(false));
  expect(loop).not.toHaveBeenCalled();
});

it('ignores a query resolving after unmount', async () => {
  let resolve!: (value: boolean) => void;
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(done => { resolve = done; }));
  const view = render(<HeartButton {...props} />);
  view.unmount();
  await act(async () => resolve(false));
});

it('defaults to static when the accessibility query rejects', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockRejectedValue(new Error('unavailable'));
  const loop = jest.spyOn(Animated, 'loop');
  render(<HeartButton {...props} />);
  await act(async () => {});
  expect(loop).not.toHaveBeenCalled();
});
