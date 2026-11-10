import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';
import type { InviteView } from './invitations-controller';

export type InvitationPanelProps = {
  locale: 'ru' | 'en';
  view: InviteView;
  onRead: () => void;
  onIssue: () => void;
  onRevoke: () => void;
  onToken: (value: string) => void;
  onPreview: () => void;
  onConsent: (value: boolean) => void;
  onAccept: () => void;
  onCancel: () => void;
};

const copy = {
  en: {
    title: 'Test invitation',
    synthetic: 'Synthetic accounts only. Nothing is shared or delivered externally. No automatic clipboard access or sharing.',
    owner: 'This account owns a waiting space and cannot accept another invitation.',
    read: 'Read invitation status', issue: 'Issue test invitation', revoke: 'Revoke current invitation',
    retryRevoke: 'Retry the same revocation',
    readNotice: 'Read the status to check whether an invitation exists.',
    status: 'Invitation status', expires: 'Expires at (UTC)',
    pending: 'Pending', expired: 'Expired', revoked: 'Revoked', consumed: 'Accepted',
    token: 'New one-time test token',
    tokenNotice: 'This token is shown only from the issuing response and kept in memory. Hiding this panel, refreshing the session, reloading or signing out clears it. It cannot be recovered. To replace it, explicitly read the status, revoke the current invitation, then issue a new one.',
    input: 'Test invitation token',
    manual: 'Enter a test token manually, then preview it. Previewing does not join a space or reveal private content.',
    preview: 'Preview test invitation',
    previewReady: 'Invitation preview',
    consent: 'I agree to join this test space and share its chat with the other member.',
    accept: 'Accept test invitation', retryAccept: 'Retry the same acceptance',
    busy: 'Invitation request in progress.',
    failure: 'The invitation request could not be completed. No private details are shown.',
    cancelled: 'The local invitation operation was cancelled. A request already sent may still complete on the server.',
    cancel: 'Clear invitation and cancel locally',
    cancelNotice: 'Clearing removes tokens and consent from this screen. It does not undo a request already sent to the server.',
    issue_uncertain: 'The issuing outcome is unknown. A token may have been created, but cannot be recovered. Read the status, revoke the current invitation if present, then issue a new one.',
    revoke_required: 'The previous token cannot be recovered. Revoke the current invitation before issuing a replacement.',
    revoke_uncertain: 'The revocation outcome is unknown. Retry the same revocation or read the current status before issuing another invitation.',
    accept_uncertain: 'The acceptance outcome is unknown. You may already have joined. Retry the same acceptance request without previewing again.',
  },
  ru: {
    title: 'Тестовое приглашение',
    synthetic: 'Только синтетические аккаунты. Внешней отправки нет. Автоматического доступа к буферу обмена и передачи токена нет.',
    owner: 'У этого аккаунта уже есть пространство ожидания. Принять другое приглашение нельзя.',
    read: 'Проверить статус приглашения', issue: 'Выпустить тестовое приглашение', revoke: 'Отозвать текущее приглашение',
    retryRevoke: 'Повторить тот же отзыв',
    readNotice: 'Явно проверьте статус, чтобы узнать, есть ли приглашение.',
    status: 'Статус приглашения', expires: 'Срок действия (UTC)',
    pending: 'Ожидает принятия', expired: 'Истекло', revoked: 'Отозвано', consumed: 'Принято',
    token: 'Новый одноразовый тестовый токен',
    tokenNotice: 'Токен показывается только из ответа на выпуск и хранится в памяти. Закрытие панели, обновление сеанса, перезагрузка или выход удаляют его. Восстановить его нельзя. Для замены явно проверьте статус, отзовите текущее приглашение и выпустите новое.',
    input: 'Токен тестового приглашения',
    manual: 'Введите тестовый токен вручную и проверьте приглашение. Проверка не присоединяет к пространству и не раскрывает личные данные.',
    preview: 'Проверить тестовое приглашение',
    previewReady: 'Предпросмотр приглашения',
    consent: 'Я согласен присоединиться к этому тестовому пространству и открыть его чат для обоих участников.',
    accept: 'Принять тестовое приглашение', retryAccept: 'Повторить то же принятие',
    busy: 'Запрос приглашения выполняется.',
    failure: 'Не удалось завершить запрос приглашения. Личные данные не показываются.',
    cancelled: 'Локальная операция отменена. Уже отправленный запрос всё ещё может выполниться на сервере.',
    cancel: 'Очистить приглашение и отменить локально',
    cancelNotice: 'Очистка удаляет токены и согласие с этого экрана. Она не отменяет уже отправленный на сервер запрос.',
    issue_uncertain: 'Результат выпуска неизвестен. Токен мог быть создан, но восстановить его нельзя. Проверьте статус, отзовите текущее приглашение при наличии и выпустите новое.',
    revoke_required: 'Предыдущий токен нельзя восстановить. Отзовите текущее приглашение перед выпуском замены.',
    revoke_uncertain: 'Результат отзыва неизвестен. Повторите тот же отзыв или проверьте текущий статус перед выпуском нового приглашения.',
    accept_uncertain: 'Результат принятия неизвестен. Возможно, вы уже присоединились. Повторите тот же запрос принятия без нового предпросмотра.',
  },
};

type ActionProps = { label: string; disabled?: boolean; onPress: () => void };
function Action({ label, disabled = false, onPress }: ActionProps) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.action, disabled && styles.disabled]}>
    <Text style={[styles.actionText, disabled && styles.disabledText]}>{label}</Text>
  </Pressable>;
}

/** Synthetic-only, controlled and ephemeral. No clipboard, links, persistence or delivery. */
export function InvitationPanel({ locale, view, onRead, onIssue, onRevoke, onToken,
  onPreview, onConsent, onAccept, onCancel }: InvitationPanelProps) {
  if (view.mode === 'unavailable') return null;
  const t = copy[locale];
  const busy = view.busy !== null;
  const retryAcceptance = view.recovery === 'accept_uncertain';
  const locked = busy || retryAcceptance;
  const current = view.invitation;
  const canRevoke = current?.status === 'pending' || current?.status === 'expired'
    || view.recovery === 'revoke_uncertain';
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.heading}>{t.title}</Text>
    <Text style={styles.body}>{t.synthetic}</Text>
    {busy && <Text accessibilityLiveRegion="polite" style={styles.body}>{t.busy}</Text>}
    {view.recovery !== 'none' && <Text accessibilityRole="alert" accessibilityLiveRegion="assertive"
      style={styles.notice}>{t[view.recovery]}</Text>}
    {view.error && view.recovery === 'none' && <Text accessibilityRole="alert" accessibilityLiveRegion="assertive"
      style={styles.notice}>{view.error === 'cancelled' ? t.cancelled : t.failure}</Text>}
    {view.mode === 'owner' ? <>
      <Text style={styles.body}>{t.owner}</Text>
      {current ? <View style={styles.summary}>
        <Text style={styles.label}>{t.status}: {t[current.status]}</Text>
        <Text style={styles.body}>{t.expires}: {current.expiresAt}</Text>
      </View> : <Text style={styles.body}>{t.readNotice}</Text>}
      <Action label={t.read} disabled={busy} onPress={onRead} />
      <Action label={t.issue} disabled={busy || view.recovery !== 'none' || current?.status === 'pending'} onPress={onIssue} />
      <Action label={view.recovery === 'revoke_uncertain' ? t.retryRevoke : t.revoke}
        disabled={busy || !canRevoke} onPress={onRevoke} />
      <Text style={styles.body}>{t.tokenNotice}</Text>
      {view.issuedToken !== null && <View style={styles.summary}>
        <Text accessibilityRole="header" style={styles.label}>{t.token}</Text>
        <Text selectable={false} testID="issued-invitation-token" style={styles.token}>{view.issuedToken}</Text>
      </View>}
    </> : <>
      <Text style={styles.body}>{t.manual}</Text>
      <Text style={styles.label}>{t.input}</Text>
      <TextInput accessibilityLabel={t.input} value={view.tokenInput} onChangeText={onToken}
        editable={!locked} accessibilityState={{ disabled: locked }} secureTextEntry
        autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none"
        importantForAutofill="no" style={styles.input} />
      <Action label={t.preview} disabled={locked || view.tokenInput.trim().length === 0} onPress={onPreview} />
      {view.preview && <View style={styles.summary}>
        <Text accessibilityRole="header" style={styles.label}>{t.previewReady}</Text>
        <Text style={styles.body}>{t.expires}: {view.preview.expiresAt}</Text>
        <Pressable accessibilityRole="checkbox" accessibilityLabel={t.consent}
          accessibilityState={{ checked: view.consent, disabled: locked }} disabled={locked}
          onPress={() => onConsent(!view.consent)} style={[styles.consent, locked && styles.disabled]}>
          <Text accessible={false} style={styles.check}>{view.consent ? '☑' : '☐'}</Text>
          <Text style={styles.consentText}>{t.consent}</Text>
        </Pressable>
      </View>}
      <Action label={retryAcceptance ? t.retryAccept : t.accept}
        disabled={busy || (!retryAcceptance && (!view.preview || !view.consent))} onPress={onAccept} />
    </>}
    <Text style={styles.body}>{t.cancelNotice}</Text>
    <Action label={t.cancel} onPress={onCancel} />
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.card, padding: spacing.md, gap: spacing.sm },
  heading: { ...typography.card, color: colors.ink },
  body: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  label: { color: colors.ink, fontSize: 15, lineHeight: 23, fontWeight: '600' },
  notice: { color: colors.accent, backgroundColor: colors.blush,
    borderRadius: radii.control, padding: spacing.md, fontSize: 15, lineHeight: 23 },
  summary: { backgroundColor: colors.letter, borderRadius: radii.control, padding: spacing.md, gap: spacing.sm },
  token: { color: colors.ink, fontSize: 16, lineHeight: 24 },
  input: { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border,
    borderWidth: 1, borderRadius: radii.control, padding: spacing.md, minHeight: 48, fontSize: 16, lineHeight: 24 },
  action: { backgroundColor: colors.accent, borderRadius: radii.control, padding: spacing.md,
    minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: colors.surface, fontSize: 16, lineHeight: 24, fontWeight: '600', textAlign: 'center' },
  disabled: { backgroundColor: colors.paperDeep },
  disabledText: { color: colors.muted },
  consent: { borderWidth: 1, borderColor: colors.accent, borderRadius: radii.control,
    padding: spacing.md, minHeight: 48, flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  check: { color: colors.accent, fontSize: 24 },
  consentText: { color: colors.ink, fontSize: 15, lineHeight: 23, flex: 1 },
});
