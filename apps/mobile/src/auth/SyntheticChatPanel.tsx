import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';

export type SyntheticChatPanelProps = {
  locale: 'ru' | 'en';
  phase: 'signed_out' | 'busy' | 'signed_in' | 'blocked';
  error: string | null;
  draft: string;
  messages: readonly { id: string; body: string; senderId: string }[];
  onDraft: (value: string) => void;
  onSignIn: (email: string, password: string) => void;
  onSignOut: () => void;
  onSend: () => void;
  onRefresh: () => void;
};

const copy = {
  ru: {
    title: 'Тестовый чат',
    unmapped: 'Тестовый аккаунт ещё не связан с профилем. Создание профиля здесь недоступно.',
    noPair: 'У тестового профиля нет активной пары. Создание пары здесь недоступно.',
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
    empty: 'Тестовых сообщений пока нет.',
    sender: 'Тестовый отправитель',
    draft: 'Тестовое сообщение',
    send: 'Отправить тестовое сообщение',
    refresh: 'Обновить историю',
  },
  en: {
    title: 'Test chat',
    unmapped: 'This test account has no linked profile. Profile creation is not available here.',
    noPair: 'This test profile has no active pair. Pair creation is not available here.',
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
    empty: 'No test messages yet.',
    sender: 'Test sender',
    draft: 'Test message',
    send: 'Send test message',
    refresh: 'Refresh history',
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
  locale, phase, error, draft, messages, onDraft, onSignIn, onSignOut, onSend, onRefresh,
}: SyntheticChatPanelProps) {
  const t = copy[locale];
  const [email, setEmail] = useState('');

  return <View style={styles.container}>
    <Text style={styles.mode}>{t.mode}</Text>
    <Text accessibilityRole="header" style={styles.title}>{t.title}</Text>
    <Text style={styles.body}>{t.notice}</Text>
    <Text accessibilityLiveRegion="polite" style={styles.status}>{t[phase]}</Text>
    {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive"
      style={styles.error}>{error === 'context_unmapped' ? t.unmapped : error === 'context_no_active_pair' ? t.noPair : error}</Text> : null}
    {/* Remounting on each phase change clears the password before the next paint. */}
    {phase !== 'signed_in' ? <Login key={phase} locale={locale} phase={phase}
      email={email} onEmail={setEmail} onSignIn={onSignIn} onSignOut={onSignOut} /> : <>
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.heading}>{t.history}</Text>
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
        <Action label={t.send} disabled={draft.trim().length === 0} onPress={onSend} />
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
