import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { PairspaceApp } from '../App';
import type { SessionController } from '../src/auth/SyntheticChatConnected';
import type { InviteView } from '../src/auth/invitations-controller';
import type { AuthView } from '../src/auth/controller';
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
it('connects opt-in synthetic chat without changing navigation or the heart', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  let view: AuthView = { phase: 'signed_out', error: null, draft: '', messages: [] };
  const listeners = new Set<() => void>();
  const inviteView: InviteView = { mode: 'unavailable', busy: null, error: null, invitation: null,
    issuedToken: null, tokenInput: '', preview: null, consent: false, recovery: 'none' };
  const controller: SessionController = {
    invitations: { getSnapshot: () => inviteView, subscribe: () => () => {},
      readMetadata: jest.fn(async () => {}), issue: jest.fn(async () => {}), revoke: jest.fn(async () => {}),
      setToken: jest.fn(), preview: jest.fn(async () => {}), setConsent: jest.fn(),
      accept: jest.fn(async () => {}), cancel: jest.fn(),
    },
    dispose: jest.fn(), loadOlder: jest.fn(async () => {}),
    getSnapshot: () => view,
    subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    setDraft: jest.fn(), signIn: jest.fn(async () => {}), signOut: jest.fn(async () => {}),
    createWaitingSpace: jest.fn(async () => {}), createProfile: jest.fn(async () => {}), send: jest.fn(async () => {}), refresh: jest.fn(async () => {}),
  };
  render(<PairspaceApp syntheticController={controller} />);
  await act(async () => {});
  fireEvent.press(screen.getByRole('tab', { name: 'Чат' }));
  // Labels intentionally taken from localized form to exercise actual user actions.
  fireEvent.changeText(screen.getByLabelText('Email тестового аккаунта'), 'synthetic@example.test');
  fireEvent.changeText(screen.getByLabelText('Пароль тестового аккаунта'), 'synthetic-password');
  fireEvent.press(screen.getByRole('button', { name: 'Войти в тестовый чат' }));
  expect(controller.signIn).toHaveBeenCalledWith('synthetic@example.test', 'synthetic-password');
  await act(async () => {
    view = { ...view, phase: 'signed_in' };
    listeners.forEach(callback => callback());
  });
  fireEvent.changeText(screen.getByLabelText('Тестовое сообщение'), 'synthetic body');
  expect(controller.setDraft).toHaveBeenCalledWith('synthetic body');
  await act(async () => { view = { ...view, draft: 'synthetic body' }; listeners.forEach(callback => callback()); });
  fireEvent.press(screen.getByRole('button', { name: 'Отправить тестовое сообщение' }));
  fireEvent.press(screen.getByRole('button', { name: 'Обновить историю' }));
  fireEvent.press(screen.getByRole('button', { name: 'Выйти' }));
  expect(controller.send).toHaveBeenCalled(); expect(controller.refresh).toHaveBeenCalled(); expect(controller.signOut).toHaveBeenCalled();
  await act(async () => { view = { ...view, phase: 'blocked', error: 'context_unmapped' }; listeners.forEach(callback => callback()); });
  fireEvent.press(screen.getByRole('button', { name: 'Создать тестовый профиль' }));
  expect(controller.createProfile).toHaveBeenCalledTimes(1);
  await act(async () => { view = { ...view, phase: 'blocked', error: 'context_no_active_pair' }; listeners.forEach(callback => callback()); });
  fireEvent.press(screen.getByRole('button', { name: 'Создать пространство ожидания' }));
  expect(controller.createWaitingSpace).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
});
