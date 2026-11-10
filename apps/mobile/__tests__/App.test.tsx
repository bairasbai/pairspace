import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Alert, Platform } from 'react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import App from '../App';
import { copy } from '../src/copy';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each(['ios', 'android'])('navigates and keeps a draft only in this session on %s', async os => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
  render(<App />);
  await act(async () => {});
  expect(screen.getByText(copy.ru.preview)).toBeTruthy();
  fireEvent.press(screen.getByRole('tab', { name: 'Чат' }));
  expect(screen.getByText(copy.ru.chatInfo)).toBeTruthy();
  expect(screen.getByRole('button', { name: copy.ru.clear })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText(copy.ru.draft), 'Only a sample');
  fireEvent.press(screen.getByRole('tab', { name: 'Вместе' }));
  for (const feature of copy.ru.features) expect(screen.getByText(`• ${feature}`)).toBeTruthy();
  fireEvent.press(screen.getByRole('tab', { name: 'Мы' }));
  fireEvent.press(screen.getByRole('radio', { name: 'English' }));
  expect(screen.getByText(copy.en.preview)).toBeTruthy();
  fireEvent.press(screen.getByRole('tab', { name: 'Chat' }));
  expect(screen.getByDisplayValue('Only a sample')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: copy.en.clear }));
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
  expect(buttons[0].style).toBe('cancel');
  expect(screen.getByDisplayValue('Only a sample')).toBeTruthy();
  act(() => buttons[1].onPress!());
  expect(screen.getByLabelText(copy.en.draft).props.value).toBe('');
  fireEvent.press(screen.getByRole('button', { name: copy.en.heart }));
  expect(Alert.alert).toHaveBeenLastCalledWith(copy.en.heart, copy.en.heartNotice, [{ text: copy.en.close }]);
  fireEvent.press(screen.getByRole('tab', { name: 'Us' }));
  fireEvent.press(screen.getByRole('radio', { name: 'Русский' }));
  fireEvent.press(screen.getByRole('tab', { name: 'Сегодня' }));
  expect(screen.getByText(copy.ru.intro)).toBeTruthy();
});

it('does not persist the draft across unmount and restart', async () => {
  const first = render(<App />);
  await act(async () => {});
  fireEvent.press(screen.getByRole('tab', { name: 'Чат' }));
  fireEvent.changeText(screen.getByLabelText(copy.ru.draft), 'sample');
  first.unmount();
  render(<App />);
  await act(async () => {});
  fireEvent.press(screen.getByRole('tab', { name: 'Чат' }));
  expect(screen.getByLabelText(copy.ru.draft).props.value).toBe('');
  expect(screen.getByLabelText(copy.ru.draft).props.maxLength).toBe(2000);
});

it('keeps both locale dictionaries structurally equivalent', () => {
  expect(Object.keys(copy.ru)).toEqual(Object.keys(copy.en));
  expect(copy.ru.features.length).toBe(copy.en.features.length);
});
