import { fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatPanel, type SyntheticChatPanelProps } from '../src/auth/SyntheticChatPanel';

function props(overrides: Partial<SyntheticChatPanelProps> = {}): SyntheticChatPanelProps {
  return {
    locale: 'en', phase: 'signed_out', error: null, draft: '', messages: [],
    onDraft: jest.fn(), onSignIn: jest.fn(), onSignOut: jest.fn(),
    onSend: jest.fn(), onRefresh: jest.fn(), ...overrides,
  };
}

const labels = {
  en: {
    title: 'Test chat', mode: 'Synthetic test mode', email: 'Test account email',
    password: 'Test account password', signIn: 'Sign in to test chat',
    signOut: 'Sign out', draft: 'Test message', send: 'Send test message',
    refresh: 'Refresh history', empty: 'No test messages yet.', sender: 'Test sender',
    signed_out: 'Sign in with a test account.', busy: 'Request in progress. Please wait.',
    signed_in: 'Test session is open.',
    blocked: 'Test session is blocked. Complete sign-out before signing in again.',
    retrySignOut: 'Retry sign-out', cancel: 'Cancel and sign out',
  },
  ru: {
    title: 'Тестовый чат', mode: 'Синтетический тестовый режим', email: 'Email тестового аккаунта',
    password: 'Пароль тестового аккаунта', signIn: 'Войти в тестовый чат',
    signOut: 'Выйти', draft: 'Тестовое сообщение', send: 'Отправить тестовое сообщение',
    refresh: 'Обновить историю', empty: 'Тестовых сообщений пока нет.', sender: 'Тестовый отправитель',
    signed_out: 'Войдите с тестовым аккаунтом.', busy: 'Выполняется запрос. Подождите.',
    signed_in: 'Тестовый сеанс открыт.',
    blocked: 'Тестовый сеанс заблокирован. Завершите выход перед новым входом.',
    retrySignOut: 'Повторить выход', cancel: 'Отменить и выйти',
  },
};

it.each(['ru', 'en'] as const)('labels the synthetic login and session actions honestly in %s', locale => {
  const t = labels[locale];
  const p = props({ locale });
  const view = render(<SyntheticChatPanel {...p} />);
  expect(screen.getByRole('header', { name: t.title })).toBeOnTheScreen();
  expect(screen.getByText(t.mode)).toBeOnTheScreen();
  expect(screen.getByText(t.signed_out)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: t.signIn })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText(t.email), '  fixture@example.test  ');
  fireEvent.changeText(screen.getByLabelText(t.password), 'synthetic-password');
  fireEvent.press(screen.getByRole('button', { name: t.signIn }));
  expect(p.onSignIn).toHaveBeenCalledWith('fixture@example.test', 'synthetic-password');
  expect(screen.getByLabelText(t.password)).toHaveDisplayValue('');

  view.rerender(<SyntheticChatPanel {...p} phase="signed_in" />);
  expect(screen.getByText(t.signed_in)).toBeOnTheScreen();
  expect(screen.getByText(t.empty)).toBeOnTheScreen();
  expect(screen.queryByLabelText(t.password)).toBeNull();
  expect(screen.getByRole('button', { name: t.send })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: t.refresh }));
  fireEvent.press(screen.getByRole('button', { name: t.signOut }));
  expect(p.onRefresh).toHaveBeenCalledTimes(1);
  expect(p.onSignOut).toHaveBeenCalledTimes(1);
});

it('rejects empty credentials and clears the password before allowing another submit', () => {
  const p = props();
  render(<SyntheticChatPanel {...p} />);
  const password = screen.getByLabelText(labels.en.password);
  const submit = screen.getByRole('button', { name: labels.en.signIn });
  fireEvent(password, 'submitEditing');
  fireEvent.press(submit);
  expect(p.onSignIn).not.toHaveBeenCalled();
  fireEvent.changeText(password, 'synthetic-password');
  fireEvent.changeText(screen.getByLabelText(labels.en.email), '   ');
  expect(submit).toBeDisabled();
  fireEvent(password, 'submitEditing');
  expect(p.onSignIn).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText(labels.en.email), 'fixture@example.test');
  fireEvent(password, 'submitEditing');
  fireEvent(password, 'submitEditing');
  fireEvent.press(submit);
  expect(p.onSignIn).toHaveBeenCalledTimes(1);
  expect(submit).toBeDisabled();
  expect(password).toHaveDisplayValue('');
  expect(password.props.secureTextEntry).toBe(true);
  expect(password.props.autoComplete).toBe('off');
  expect(password.props.importantForAutofill).toBe('no');
});

it.each(['busy', 'blocked'] as const)('clears passwords and prevents actions while %s', phase => {
  const p = props({ draft: 'Synthetic draft', messages: [{ id: 'm1', body: 'Synthetic history', senderId: 'test-a' }] });
  const view = render(<SyntheticChatPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(labels.en.email), 'fixture@example.test');
  fireEvent.changeText(screen.getByLabelText(labels.en.password), 'synthetic-password');
  view.rerender(<SyntheticChatPanel {...p} phase={phase} />);
  expect(screen.getByText(labels.en[phase])).toBeOnTheScreen();
  expect(screen.getByLabelText(labels.en.email)).toBeDisabled();
  expect(screen.getByLabelText(labels.en.password)).toBeDisabled();
  expect(screen.getByLabelText(labels.en.password)).toHaveDisplayValue('');
  expect(screen.queryByText('Synthetic history')).toBeNull();
  expect(screen.queryByDisplayValue('Synthetic draft')).toBeNull();
  expect(screen.queryByRole('button', { name: labels.en.send })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: labels.en.signIn }));
  fireEvent(screen.getByLabelText(labels.en.password), 'submitEditing');
  expect(p.onSignIn).not.toHaveBeenCalled();
  const exitLabel = phase === 'blocked' ? labels.en.retrySignOut : labels.en.cancel;
  const exit = screen.getByRole('button', { name: exitLabel });
  expect(exit).toBeEnabled();
  fireEvent.press(exit);
  expect(p.onSignOut).toHaveBeenCalledTimes(1);
  view.rerender(<SyntheticChatPanel {...p} />);
  expect(screen.getByLabelText(labels.en.password)).toHaveDisplayValue('');
  expect(screen.getByRole('button', { name: labels.en.signIn })).toBeDisabled();
});

it.each(['ru', 'en'] as const)('translates busy and blocked status in %s', locale => {
  const p = props({ locale, phase: 'busy' });
  const view = render(<SyntheticChatPanel {...p} />);
  expect(screen.getByText(labels[locale].busy)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: labels[locale].cancel })).toBeEnabled();
  view.rerender(<SyntheticChatPanel {...p} phase="blocked" />);
  expect(screen.getByText(labels[locale].blocked)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: labels[locale].retrySignOut })).toBeEnabled();
});

it('renders parent-owned messages and composer without inventing delivery state', () => {
  const p = props({
    phase: 'signed_in', draft: 'Synthetic draft',
    messages: [{ id: 'm1', body: 'Sample 🌷\nSecond line', senderId: 'test-a' }],
  });
  const view = render(<SyntheticChatPanel {...p} />);
  expect(screen.getByText('Sample 🌷\nSecond line')).toBeOnTheScreen();
  expect(screen.getByText('Test sender: test-a')).toBeOnTheScreen();
  expect(screen.queryByText(labels.en.empty)).toBeNull();
  fireEvent.changeText(screen.getByLabelText(labels.en.draft), 'Edited synthetic draft');
  expect(p.onDraft).toHaveBeenCalledWith('Edited synthetic draft');
  expect(screen.getByLabelText(labels.en.draft)).toHaveDisplayValue('Synthetic draft');
  fireEvent.press(screen.getByRole('button', { name: labels.en.send }));
  expect(p.onSend).toHaveBeenCalledTimes(1);
  expect(p.onDraft).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText(labels.en.draft)).toHaveDisplayValue('Synthetic draft');
  view.rerender(<SyntheticChatPanel {...p} phase="busy" />);
  expect(screen.queryByText('Sample 🌷\nSecond line')).toBeNull();
  expect(screen.queryByLabelText(labels.en.draft)).toBeNull();
  view.rerender(<SyntheticChatPanel {...p} locale="ru" />);
  expect(screen.getByText('Тестовый отправитель: test-a')).toBeOnTheScreen();
  expect(screen.getByLabelText(labels.ru.draft)).toHaveDisplayValue('Synthetic draft');
});

it.each(['', ' ', '\n\t'])('does not send an empty or whitespace-only draft %j', draft => {
  const p = props({ phase: 'signed_in', draft });
  render(<SyntheticChatPanel {...p} />);
  const send = screen.getByRole('button', { name: labels.en.send });
  expect(send).toBeDisabled();
  fireEvent.press(send);
  expect(p.onSend).not.toHaveBeenCalled();
});

it('shows controlled errors accessibly and supports a fresh login after failure', () => {
  const p = props();
  const view = render(<SyntheticChatPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(labels.en.email), 'fixture@example.test');
  fireEvent.changeText(screen.getByLabelText(labels.en.password), 'synthetic-password');
  fireEvent.press(screen.getByRole('button', { name: labels.en.signIn }));
  view.rerender(<SyntheticChatPanel {...p} phase="busy" />);
  view.rerender(<SyntheticChatPanel {...p} error="Synthetic connection failed. Try again." />);
  expect(screen.getByRole('alert')).toHaveTextContent('Synthetic connection failed. Try again.');
  expect(screen.getByLabelText(labels.en.password)).toHaveDisplayValue('');
  fireEvent.changeText(screen.getByLabelText(labels.en.password), 'new-synthetic-password');
  fireEvent.press(screen.getByRole('button', { name: labels.en.signIn }));
  expect(p.onSignIn).toHaveBeenCalledTimes(2);
  expect(p.onSignIn).toHaveBeenLastCalledWith('fixture@example.test', 'new-synthetic-password');
  view.rerender(<SyntheticChatPanel {...p} error={null} />);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('clears the password on sign-in, sign-out, interruption and remount', () => {
  const p = props();
  const view = render(<SyntheticChatPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(labels.en.password), 'synthetic-password');
  view.rerender(<SyntheticChatPanel {...p} phase="signed_in" />);
  view.rerender(<SyntheticChatPanel {...p} />);
  expect(screen.getByLabelText(labels.en.password)).toHaveDisplayValue('');
  fireEvent.changeText(screen.getByLabelText(labels.en.email), 'fixture@example.test');
  fireEvent.changeText(screen.getByLabelText(labels.en.password), 'synthetic-password');
  view.unmount();
  render(<SyntheticChatPanel {...p} />);
  expect(screen.getByLabelText(labels.en.email)).toHaveDisplayValue('');
  expect(screen.getByLabelText(labels.en.password)).toHaveDisplayValue('');
});
