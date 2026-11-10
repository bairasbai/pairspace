import type { HistoryView } from '../chat/history';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';
import { InvitationPanel, type InvitationPanelProps } from './InvitationPanel';

export type SyntheticChatPanelProps = {
  locale: 'ru' | 'en';
  phase: 'signed_out' | 'busy' | 'signed_in' | 'blocked';
  history?: HistoryView;
  onLoadOlder?: () => void;
  outgoing?: Readonly<{ body: string; status: 'sending' | 'retry' | 'sent' }>;
  error: string | null;
  draft: string;
  messages: readonly { id: string; body: string; senderId: string }[];
  onDraft: (value: string) => void;
  onSignIn: (email: string, password: string) => void;
  onSignOut: () => void;
  onSend: () => void;
  onRefresh: () => void;
  onCreateProfile: () => void;
  onCreateWaitingSpace: () => void;
  invitations?: Omit<InvitationPanelProps, 'locale'>;
};

const copy = {
  ru: {
    title: 'Тестовый чат',
    leavePending: 'Завершение пары ещё не подтверждено. Используйте проверку выше.',
    leaveFinished: 'Локальная переписка очищена. Аккаунт остаётся авторизованным.',
    refreshAccount: 'Обновить аккаунт',
    unmapped: 'Тестовый аккаунт ещё не связан с профилем. Вы можете явно создать тестовый профиль.',
    createProfile: 'Создать тестовый профиль',
    profileRetry: 'Ответ не получен. Профиль мог быть создан. Повторная проверка не создаст дубликат.',
    retryProfile: 'Повторить создание профиля',
    noPair: 'У тестового профиля нет пространства. Введите приглашение вручную или создайте своё пространство ожидания партнёра.',
    createWaiting: 'Создать пространство ожидания',
    retryWaiting: 'Повторить создание пространства',
    waiting: 'Ожидание партнёра',
    waitingNotice: 'Ваше тестовое пространство создано. Чат станет доступен после принятия приглашения партнёром.',
    waitingRetry: 'Ответ не получен. Пространство могло быть создано. Повторная проверка не создаст дубликат.',
    mode: 'Синтетический тестовый режим',
    notice: 'Только тестовые аккаунты и сообщения. Не вводите личные данные или пароли от других сервисов.',
    signed_out: 'Войдите с тестовым аккаунтом.',
    busy: 'Выполняется запрос. Подождите.',
    signed_in: 'Тестовый сеанс открыт.',
    blocked: 'Тестовый сеанс заблокирован. Завершите выход перед новым входом.',
    email: 'Email тестового аккаунта',
    password: 'Пароль тестового аккаунта',
    signIn: 'Войти в тестовый чат',
    signOut: 'Выйти',
    retrySignOut: 'Повторить выход',
    cancel: 'Отменить и выйти',
    history: 'Тестовые сообщения',
    older: 'Загрузить предыдущие сообщения',
    olderRetry: 'Повторить загрузку истории',
    historyLoading: 'История загружается…',
    historyError: 'Не удалось загрузить историю. Можно повторить запрос.',
    historyEnd: 'Начало истории.',
    historyCap: 'Показано не более 200 сообщений. Обновите историю, чтобы вернуться к последним.',
    historyWindow: 'После обновления показаны только последние 50 сообщений. Предыдущие можно загрузить снова.',
    empty: 'Тестовых сообщений пока нет.',
    sender: 'Тестовый отправитель',
    draft: 'Тестовое сообщение',
    send: 'Отправить тестовое сообщение',
    refresh: 'Обновить историю',
    sending: 'Отправляется…',
    retry: 'Подтверждение не получено. Повторите то же сообщение без дубля.',
    sent: 'Отправлено на сервер. Доставка и прочтение не подтверждены.',
    retrySend: 'Повторить то же сообщение',
    network: 'Связь временно недоступна. Черновик сохранён до выхода из экрана.',
  },
  en: {
    title: 'Test chat',
    leavePending: 'Pair closure is not yet confirmed. Use the check above.',
    leaveFinished: 'Local conversation data is cleared. Your account remains signed in.',
    refreshAccount: 'Refresh account',
    unmapped: 'This test account has no linked profile. You can explicitly create a test profile.',
    createProfile: 'Create test profile',
    profileRetry: 'No response was received. The profile may already exist. Retrying will not create a duplicate.',
    retryProfile: 'Retry profile creation',
    noPair: 'This test profile has no space. Enter an invitation manually or create your own space waiting for a partner.',
    createWaiting: 'Create waiting space',
    retryWaiting: 'Retry space creation',
    waiting: 'Waiting for a partner',
    waitingNotice: 'Your test space exists. Chat becomes available after a partner accepts an invitation.',
    waitingRetry: 'No response was received. The space may already exist. Retrying will not create a duplicate.',
    mode: 'Synthetic test mode',
    notice: 'Use test accounts and messages only. Do not enter personal data or passwords from other services.',
    signed_out: 'Sign in with a test account.',
    busy: 'Request in progress. Please wait.',
    signed_in: 'Test session is open.',
    blocked: 'Test session is blocked. Complete sign-out before signing in again.',
    email: 'Test account email',
    password: 'Test account password',
    signIn: 'Sign in to test chat',
    signOut: 'Sign out',
    retrySignOut: 'Retry sign-out',
    cancel: 'Cancel and sign out',
    history: 'Test messages',
    older: 'Load older messages',
    olderRetry: 'Retry loading history',
    historyLoading: 'Loading history…',
    historyError: 'Could not load history. You can retry.',
    historyEnd: 'Beginning of history.',
    historyCap: 'Up to 200 messages shown. Refresh history to return to the latest messages.',
    historyWindow: 'Refreshing shows only the latest 50 messages. You can load older messages again.',
    empty: 'No test messages yet.',
    sender: 'Test sender',
    draft: 'Test message',
    send: 'Send test message',
    refresh: 'Refresh history',
    sending: 'Sending…',
    retry: 'No confirmation received. Retry the same message without a duplicate.',
    sent: 'Sent to the server. Delivery and reading are not confirmed.',
    retrySend: 'Retry the same message',
    network: 'Connection temporarily unavailable. Draft kept until you leave this screen.',
  },
};

type ActionProps = { label: string; disabled?: boolean; onPress: () => void };

function Action({ label, disabled = false, onPress }: ActionProps) {
  return <Pressable
    accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.action, disabled && styles.disabledAction]}>
    <Text style={disabled ? styles.disabledActionText : styles.actionText}>{label}</Text>
  </Pressable>;
}

type LoginProps = Pick<SyntheticChatPanelProps, 'locale' | 'phase' | 'onSignIn' | 'onSignOut'> & {
  email: string;
  onEmail: (email: string) => void;
};

function Login({ locale, phase, email, onEmail, onSignIn, onSignOut }: LoginProps) {
  const t = copy[locale];
  const [password, setPassword] = useState('');
  const locked = phase === 'busy' || phase === 'blocked';
  const canSignIn = phase === 'signed_out' && email.trim().length > 0 && password.length > 0;

  function signIn() {
    if (!canSignIn) return;
    setPassword('');
    onSignIn(email.trim(), password);
  }

  return <View style={styles.card}>
      <Text style={styles.label}>{t.email}</Text>
      <TextInput accessibilityLabel={t.email} value={email} onChangeText={onEmail}
        editable={!locked} accessibilityState={{ disabled: locked }}
        autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        autoComplete="off" textContentType="none" importantForAutofill="no"
        style={styles.input} />
      <Text style={styles.label}>{t.password}</Text>
      <TextInput accessibilityLabel={t.password} value={password} onChangeText={setPassword}
        editable={!locked} accessibilityState={{ disabled: locked }} secureTextEntry
        autoCapitalize="none" autoCorrect={false} autoComplete="off"
        textContentType="none" importantForAutofill="no" returnKeyType="go"
        onSubmitEditing={signIn} style={styles.input} />
      <Action label={t.signIn} disabled={!canSignIn} onPress={signIn} />
      {phase === 'blocked' && <Action label={t.retrySignOut} onPress={onSignOut} />}
      {phase === 'busy' && <Action label={t.cancel} onPress={onSignOut} />}
    </View>;
}

/** Controlled synthetic-only UI. The parent owns requests, session and message state. */
export function SyntheticChatPanel({
  locale, phase, error, draft, messages, outgoing, history, onLoadOlder, onDraft, onSignIn, onSignOut, onSend, onRefresh, onCreateProfile, onCreateWaitingSpace, invitations,
}: SyntheticChatPanelProps) {
  const t = copy[locale];
  const [email, setEmail] = useState('');
  const invitationBusy = invitations !== undefined && (invitations.view.busy !== null
    || invitations.view.recovery === 'accept_uncertain');
  const invitationVisible = invitations !== undefined && invitations.view.mode !== 'unavailable'
    && phase === 'blocked';

  return <View style={styles.container}>
    <Text style={styles.mode}>{t.mode}</Text>
    <Text accessibilityRole="header" style={styles.title}>{t.title}</Text>
    <Text style={styles.body}>{t.notice}</Text>
    <Text accessibilityLiveRegion="polite" style={styles.status}>{error === 'leave_pending' || error === 'leave_finished' ? t.signed_in : error === 'context_waiting_partner' ? t.waiting : invitationVisible ? t.signed_in : t[phase]}</Text>
    {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive"
      style={styles.error}>{error === 'leave_pending' ? t.leavePending : error === 'leave_finished' ? t.leaveFinished : error === 'context_unmapped' ? t.unmapped : error === 'context_no_active_pair' ? t.noPair : error === 'profile_retry_required' ? t.profileRetry : error === 'context_waiting_partner' ? t.waitingNotice : error === 'waiting_retry_required' ? t.waitingRetry : error === 'transport_error' ? t.network : error}</Text> : null}
    {phase === 'blocked' && (error === 'context_unmapped' || error === 'profile_retry_required')
      && <Action label={error === 'context_unmapped' ? t.createProfile : t.retryProfile} onPress={onCreateProfile} />}
    {phase === 'blocked' && (error === 'context_no_active_pair' || error === 'waiting_retry_required')
      && <Action label={error === 'context_no_active_pair' ? t.createWaiting : t.retryWaiting} disabled={invitationBusy} onPress={onCreateWaitingSpace} />}
    {invitationVisible && <InvitationPanel {...invitations} locale={locale} />}
    {/* Remounting on each phase change clears the password before the next paint. */}
    {phase === 'blocked' && (error === 'leave_pending' || error === 'leave_finished') ? <View style={styles.card}>
      <Action label={t.refreshAccount} disabled={error === 'leave_pending'} onPress={onRefresh} />
      <Action label={t.signOut} onPress={onSignOut} />
    </View> : phase === 'blocked' && (error === 'context_waiting_partner' || invitationVisible) ? <View style={styles.card}>
      <Action label={t.refresh} disabled={invitationBusy} onPress={onRefresh} />
      <Action label={t.signOut} onPress={onSignOut} />
    </View> : phase !== 'signed_in' ? <Login key={phase} locale={locale} phase={phase}
      email={email} onEmail={setEmail} onSignIn={onSignIn} onSignOut={onSignOut} /> : <>
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.heading}>{t.history}</Text>
        {history && <View>
          {history.windowReset && <Text>{t.historyWindow}</Text>}
          {history.status === 'loading' && <Text accessibilityLiveRegion="polite">{t.historyLoading}</Text>}
          {history.status === 'error' && <Text accessibilityRole="alert">{t.historyError}</Text>}
          {history.status === 'ready' && history.nextBeforeSeq === null && <Text>{t.historyEnd}</Text>}
          {history.nextBeforeSeq !== null && messages.length >= 200 && <Text>{t.historyCap}</Text>}
          {history.nextBeforeSeq !== null && messages.length < 200 && onLoadOlder &&
            <Action label={history.status === 'error' ? t.olderRetry : t.older}
              disabled={history.status === 'loading'} onPress={onLoadOlder} />}
        </View>}
        {messages.length === 0 ? <Text style={styles.body}>{t.empty}</Text> : messages.map(message =>
          <View key={message.id} style={styles.message}>
            <Text style={styles.sender}>{t.sender}: {message.senderId}</Text>
            <Text selectable style={styles.messageBody}>{message.body}</Text>
          </View>)}
        <Action label={t.refresh} onPress={onRefresh} />
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>{t.draft}</Text>
        <TextInput accessibilityLabel={t.draft} value={draft} onChangeText={onDraft}
          multiline textAlignVertical="top" style={[styles.input, styles.composer]} />
        {outgoing && <View>
          <Text selectable>{outgoing.body}</Text>
          <Text accessibilityLiveRegion="polite">{t[outgoing.status]}</Text>
        </View>}
        <Action label={outgoing?.status === 'retry' ? t.retrySend : t.send}
          disabled={outgoing?.status === 'sending' || (outgoing?.status !== 'retry' && draft.trim().length === 0)} onPress={onSend} />
      </View>
      <Action label={t.signOut} onPress={onSignOut} />
    </>}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  mode: { color: colors.accent, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  title: { ...typography.display, color: colors.ink },
  heading: { ...typography.card, color: colors.ink },
  body: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  status: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  error: { color: colors.accent, backgroundColor: colors.blush, borderRadius: radii.control,
    padding: spacing.md, fontSize: 15, lineHeight: 23 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.card, padding: spacing.md, gap: spacing.sm },
  label: { color: colors.ink, fontSize: 15, lineHeight: 23, fontWeight: '600' },
  input: { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border,
    borderWidth: 1, borderRadius: radii.control, padding: spacing.md, minHeight: 48,
    fontSize: 16, lineHeight: 24 },
  composer: { minHeight: 112 },
  action: { backgroundColor: colors.accent, borderRadius: radii.control, padding: spacing.md,
    minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: colors.surface, fontSize: 16, lineHeight: 24, fontWeight: '600', textAlign: 'center' },
  disabledAction: { backgroundColor: colors.paperDeep },
  disabledActionText: { color: colors.muted, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  message: { backgroundColor: colors.letter, borderRadius: radii.control,
    padding: spacing.md, gap: spacing.xs },
  sender: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  messageBody: { color: colors.ink, fontSize: 16, lineHeight: 24 },
});
