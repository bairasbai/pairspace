import { fireEvent, render, screen } from '@testing-library/react-native';
import { InvitationPanel, type InvitationPanelProps } from '../src/auth/InvitationPanel';
import type { InviteView } from '../src/auth/invitations-controller';
import type { InvitationMetadata } from '../src/auth/invitations';

const metadata: InvitationMetadata = {
  id: 'synthetic-invitation', commandId: 'synthetic-command', status: 'pending',
  createdAt: '2026-11-10T09:00:00.000Z', expiresAt: '2026-11-11T09:00:00.000Z',
  revokedAt: null, consumedAt: null,
};
const empty: InviteView = { mode: 'recipient', busy: null, error: null, invitation: null,
  issuedToken: null, tokenInput: '', preview: null, consent: false, recovery: 'none' };
const labels = {
  en: {
    title: 'Test invitation', read: 'Read invitation status', issue: 'Issue test invitation',
    revoke: 'Revoke current invitation', retryRevoke: 'Retry the same revocation',
    input: 'Test invitation token', preview: 'Preview test invitation', previewReady: 'Invitation preview',
    consent: 'I agree to join this test space and share its chat with the other member.',
    accept: 'Accept test invitation', retryAccept: 'Retry the same acceptance',
    cancel: 'Clear invitation and cancel locally', busy: 'Invitation request in progress.',
  },
  ru: {
    title: 'Тестовое приглашение', read: 'Проверить статус приглашения', issue: 'Выпустить тестовое приглашение',
    revoke: 'Отозвать текущее приглашение', retryRevoke: 'Повторить тот же отзыв',
    input: 'Токен тестового приглашения', preview: 'Проверить тестовое приглашение', previewReady: 'Предпросмотр приглашения',
    consent: 'Я согласен присоединиться к этому тестовому пространству и открыть его чат для обоих участников.',
    accept: 'Принять тестовое приглашение', retryAccept: 'Повторить то же принятие',
    cancel: 'Очистить приглашение и отменить локально', busy: 'Запрос приглашения выполняется.',
  },
};
function props(overrides: Partial<InviteView> = {}, locale: 'ru' | 'en' = 'en'): InvitationPanelProps {
  return { locale, view: { ...empty, ...overrides }, onRead: jest.fn(), onIssue: jest.fn(),
    onRevoke: jest.fn(), onToken: jest.fn(), onPreview: jest.fn(), onConsent: jest.fn(),
    onAccept: jest.fn(), onCancel: jest.fn() };
}
// Queries never dump the tree, which can contain an ephemeral synthetic token.
function button(name: string) {
  const result = screen.queryByRole('button', { name });
  if (!result) throw new Error('Expected invitation action is absent');
  return result;
}
function input(name: string) {
  const result = screen.queryByLabelText(name);
  if (!result) throw new Error('Expected invitation input is absent');
  return result;
}
function checkbox(name: string) {
  const result = screen.queryByRole('checkbox', { name });
  if (!result) throw new Error('Expected invitation consent is absent');
  return result;
}

it('renders no invitation entry point for unavailable contexts', () => {
  const p = props({ mode: 'unavailable' });
  render(<InvitationPanel {...p} />);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(p.onRead).not.toHaveBeenCalled(); expect(p.onPreview).not.toHaveBeenCalled();
});

it.each(['ru', 'en'] as const)('requires explicit owner actions and labels them accessibly in %s', locale => {
  const p = props({ mode: 'owner' }, locale); const t = labels[locale];
  const ui = render(<InvitationPanel {...p} />);
  expect(screen.queryByRole('header', { name: t.title }) !== null).toBe(true);
  expect(screen.queryByLabelText(t.input) === null).toBe(true);
  expect(screen.queryByRole('button', { name: t.accept })).toBeNull();
  expect(p.onRead).not.toHaveBeenCalled(); expect(p.onIssue).not.toHaveBeenCalled();
  expect(p.onRevoke).not.toHaveBeenCalled();
  fireEvent.press(button(t.read)); fireEvent.press(button(t.issue));
  expect(p.onRead).toHaveBeenCalledTimes(1); expect(p.onIssue).toHaveBeenCalledTimes(1);
  expect(button(t.revoke)).toBeDisabled(); fireEvent.press(button(t.revoke));
  expect(p.onRevoke).not.toHaveBeenCalled();
  ui.rerender(<InvitationPanel {...p} view={{ ...p.view, invitation: metadata }} />);
  expect(button(t.issue)).toBeDisabled(); fireEvent.press(button(t.issue));
  expect(p.onIssue).toHaveBeenCalledTimes(1);
  expect(button(t.revoke)).toBeEnabled(); fireEvent.press(button(t.revoke));
  expect(p.onRevoke).toHaveBeenCalledTimes(1);
  fireEvent.press(button(t.cancel)); expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(locale === 'en'
    ? 'Synthetic accounts only. Nothing is shared or delivered externally. No automatic clipboard access or sharing.'
    : 'Только синтетические аккаунты. Внешней отправки нет. Автоматического доступа к буферу обмена и передачи токена нет.') !== null).toBe(true);
});

it.each(['pending', 'expired', 'revoked', 'consumed'] as const)('shows safe %s metadata with conditional revocation', status => {
  render(<InvitationPanel {...props({ mode: 'owner', invitation: { ...metadata, status } })} />);
  expect(screen.queryByText('Expires at (UTC): ' + metadata.expiresAt) !== null).toBe(true);
  expect(button(labels.en.revoke).props.accessibilityState.disabled).toBe(!['pending', 'expired'].includes(status));
  expect(button(labels.en.issue).props.accessibilityState.disabled).toBe(status === 'pending');
  expect(screen.queryByTestId('issued-invitation-token') === null).toBe(true);
});

it('shows a newly issued token only while the controller includes that one-response value', () => {
  const fixture = 'synthetic-only-one-response';
  const p = props({ mode: 'owner', invitation: metadata, issuedToken: fixture });
  const ui = render(<InvitationPanel {...p} />);
  const token = screen.queryByTestId('issued-invitation-token');
  expect(token?.props.children === fixture).toBe(true);
  expect(token?.props.selectable).toBe(false);
  expect(screen.queryAllByRole('button').some(node => /copy|share|send/i.test(node.props.accessibilityLabel))).toBe(false);
  ui.rerender(<InvitationPanel {...p} view={{ ...p.view, issuedToken: null }} />);
  expect(screen.queryByTestId('issued-invitation-token') === null).toBe(true);
  ui.rerender(<InvitationPanel {...p} view={{ ...empty, mode: 'unavailable' }} />);
  expect(screen.queryByTestId('issued-invitation-token') === null).toBe(true);
});

it.each(['ru', 'en'] as const)('requires manual input, explicit preview, separate consent and explicit acceptance in %s', locale => {
  const p = props({}, locale); const t = labels[locale];
  const ui = render(<InvitationPanel {...p} />);
  expect(button(t.preview)).toBeDisabled(); expect(button(t.accept)).toBeDisabled();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(p.onPreview).not.toHaveBeenCalled(); expect(p.onAccept).not.toHaveBeenCalled();
  const field = input(t.input);
  expect(field.props.secureTextEntry).toBe(true); expect(field.props.autoComplete).toBe('off');
  expect(field.props.importantForAutofill).toBe('no'); expect(field.props.autoCorrect).toBe(false);
  fireEvent.changeText(field, 'synthetic-only-manual');
  expect(p.onToken).toHaveBeenCalledTimes(1);
  expect((p.onToken as jest.Mock).mock.calls[0][0] === 'synthetic-only-manual').toBe(true);
  expect(p.onPreview).not.toHaveBeenCalled(); expect(p.onAccept).not.toHaveBeenCalled();
  ui.rerender(<InvitationPanel {...p} view={{ ...p.view, tokenInput: 'synthetic-only-manual' }} />);
  fireEvent.press(button(t.preview)); expect(p.onPreview).toHaveBeenCalledTimes(1);
  expect(button(t.accept)).toBeDisabled(); fireEvent.press(button(t.accept));
  expect(p.onAccept).not.toHaveBeenCalled();
  const previewed = { ...p.view, tokenInput: 'synthetic-only-manual', preview: { expiresAt: metadata.expiresAt } };
  ui.rerender(<InvitationPanel {...p} view={previewed} />);
  expect(screen.queryByRole('header', { name: t.previewReady }) !== null).toBe(true);
  expect(checkbox(t.consent).props.accessibilityState.checked).toBe(false);
  expect(button(t.accept)).toBeDisabled();
  fireEvent.press(checkbox(t.consent)); expect(p.onConsent).toHaveBeenLastCalledWith(true);
  expect(p.onAccept).not.toHaveBeenCalled();
  ui.rerender(<InvitationPanel {...p} view={{ ...previewed, consent: true }} />);
  expect(checkbox(t.consent).props.accessibilityState.checked).toBe(true);
  fireEvent.press(checkbox(t.consent)); expect(p.onConsent).toHaveBeenLastCalledWith(false);
  fireEvent.press(button(t.accept)); expect(p.onAccept).toHaveBeenCalledTimes(1);
  // Controller owns clearing preview and consent when the token changes.
  fireEvent.changeText(input(t.input), 'synthetic-only-replacement');
  ui.rerender(<InvitationPanel {...p} view={{ ...empty, tokenInput: 'synthetic-only-replacement' }} />);
  expect(screen.queryByRole('checkbox')).toBeNull(); expect(button(t.accept)).toBeDisabled();
});

it.each(['', ' ', '\t\n'])('does not preview blank input %j', tokenInput => {
  const p = props({ tokenInput }); render(<InvitationPanel {...p} />);
  fireEvent.press(button(labels.en.preview)); expect(p.onPreview).not.toHaveBeenCalled();
});

it.each(['read', 'issue', 'revoke'] as const)('blocks repeated owner actions during %s but permits local cancellation', busy => {
  const p = props({ mode: 'owner', busy, invitation: metadata });
  render(<InvitationPanel {...p} />);
  for (const label of [labels.en.read, labels.en.issue, labels.en.revoke]) {
    expect(button(label)).toBeDisabled(); fireEvent.press(button(label));
  }
  expect(p.onRead).not.toHaveBeenCalled(); expect(p.onIssue).not.toHaveBeenCalled();
  expect(p.onRevoke).not.toHaveBeenCalled();
  expect(screen.queryByText(labels.en.busy)?.props.accessibilityLiveRegion).toBe('polite');
  expect(button(labels.en.cancel)).toBeEnabled(); fireEvent.press(button(labels.en.cancel));
  expect(p.onCancel).toHaveBeenCalledTimes(1);
});

it.each(['preview', 'accept'] as const)('locks input and consent during %s without hiding cancellation', busy => {
  const p = props({ busy, tokenInput: 'synthetic-only-manual', preview: { expiresAt: metadata.expiresAt }, consent: true });
  render(<InvitationPanel {...p} />);
  expect(input(labels.en.input).props.editable).toBe(false); expect(checkbox(labels.en.consent)).toBeDisabled();
  expect(button(labels.en.preview)).toBeDisabled(); expect(button(labels.en.accept)).toBeDisabled();
  fireEvent.changeText(input(labels.en.input), 'synthetic-only-edit');
  fireEvent.press(checkbox(labels.en.consent)); fireEvent.press(button(labels.en.preview));
  fireEvent.press(button(labels.en.accept)); fireEvent.press(button(labels.en.cancel));
  expect(p.onToken).not.toHaveBeenCalled(); expect(p.onConsent).not.toHaveBeenCalled();
  expect(p.onPreview).not.toHaveBeenCalled(); expect(p.onAccept).not.toHaveBeenCalled();
  expect(p.onCancel).toHaveBeenCalledTimes(1);
});

it.each(['issue_uncertain', 'revoke_required', 'revoke_uncertain'] as const)('explains owner recovery %s and prevents unsafe issuance', recovery => {
  const p = props({ mode: 'owner', recovery, error: 'invitation_retry_required' });
  render(<InvitationPanel {...p} />);
  expect(screen.queryAllByRole('alert')).toHaveLength(1);
  expect(button(labels.en.issue)).toBeDisabled();
  expect(button(labels.en.read)).toBeEnabled();
  if (recovery === 'revoke_uncertain') {
    expect(button(labels.en.retryRevoke)).toBeEnabled(); fireEvent.press(button(labels.en.retryRevoke));
    expect(p.onRevoke).toHaveBeenCalledTimes(1);
  }
});

it.each(['ru', 'en'] as const)('retries only the same unknown acceptance without another preview in %s', locale => {
  const t = labels[locale];
  const p = props({ recovery: 'accept_uncertain', error: 'invitation_retry_required' }, locale);
  render(<InvitationPanel {...p} />);
  expect(input(t.input).props.editable).toBe(false); expect(button(t.preview)).toBeDisabled();
  expect(screen.queryByRole('button', { name: t.accept })).toBeNull();
  expect(button(t.retryAccept)).toBeEnabled();
  fireEvent.press(button(t.preview)); fireEvent.press(button(t.retryAccept));
  expect(p.onPreview).not.toHaveBeenCalled(); expect(p.onAccept).toHaveBeenCalledTimes(1);
  const alert = screen.queryByRole('alert');
  expect(alert?.props.accessibilityLiveRegion).toBe('assertive');
  expect(alert?.props.children).toBe(locale === 'en'
    ? 'The acceptance outcome is unknown. You may already have joined. Retry the same acceptance request without previewing again.'
    : 'Результат принятия неизвестен. Возможно, вы уже присоединились. Повторите тот же запрос принятия без нового предпросмотра.');
});

it.each(['ru', 'en'] as const)('uses safe error text and explains cancellation without promising rollback in %s', locale => {
  const p = props({ error: 'untrusted-synthetic-error-with-payload' }, locale);
  const ui = render(<InvitationPanel {...p} />);
  expect(screen.queryByText(p.view.error!)).toBeNull();
  expect(screen.queryAllByRole('alert')).toHaveLength(1);
  ui.rerender(<InvitationPanel {...p} view={{ ...p.view, error: 'cancelled' }} />);
  expect(screen.queryByRole('alert')?.props.children).toBe(locale === 'en'
    ? 'The local invitation operation was cancelled. A request already sent may still complete on the server.'
    : 'Локальная операция отменена. Уже отправленный запрос всё ещё может выполниться на сервере.');
  fireEvent.press(button(labels[locale].cancel)); expect(p.onCancel).toHaveBeenCalledTimes(1);
});
