import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Locale } from '../copy';
import type { LeaveView } from './leave';
import { colors } from '../theme';
export const leaveCopy = {
  ru: {
    title: 'Завершить тестовую пару', begin: 'Завершить пару', confirm: 'Да, завершить эту пару', cancel: 'Остаться в паре', retry: 'Проверить и повторить завершение',
    consequences: 'Согласие партнёра не требуется. Оба участника потеряют доступ к чату, письмам, включая запечатанные, и знакам заботы. Приглашения перестанут действовать. Записи сохранятся на сервере, но не будут доступны через обычные API. Новая пара не создаётся. Это тестовый сценарий, не политика архива для реальных пользователей. Сервер хранит открытый текст, сквозного шифрования нет.',
    pending: 'Проверяем и завершаем пару… После отправки запроса отмена не может вернуть пару.',
    unknown: 'Результат неизвестен. Пара могла уже закрыться. Повтор проверит ту же команду для той же пары. Отмена ожидания не отменяет действие на сервере.',
    closed: 'Сервер подтвердил завершение выбранной пары. Обновите аккаунт, чтобы проверить текущее пространство.',
    unavailable: 'Не удалось подтвердить завершение выбранной пары. Её состояние изменилось. Обновите аккаунт перед новым действием.',
  },
  en: {
    title: 'End the test pair', begin: 'End pair', confirm: 'Yes, end this pair', cancel: 'Stay in pair', retry: 'Check and retry ending pair',
    consequences: 'Your partner’s permission is not required. Both participants lose access to chat, letters including sealed letters, and care signals. Invitations stop working. Records remain on the server but ordinary APIs cannot access them. No new pair is created. This is a test flow, not an archive policy for real users. The server stores plaintext; there is no end-to-end encryption.',
    pending: 'Checking and ending the pair… Once sent, cancelling cannot restore the pair.',
    unknown: 'The outcome is unknown. The pair may already be closed. Retry checks the same command for the same pair. Stopping the wait cannot undo the server action.',
    closed: 'The server confirmed the selected pair is closed. Refresh your account to check the current space.',
    unavailable: 'Closure of the selected pair could not be confirmed. Its state changed. Refresh your account before another action.',
  },
};
export function LeavePanel({ locale, view, onBegin, onCancel, onConfirm }: {
  locale: Locale; view: LeaveView; onBegin(): void; onCancel(): void; onConfirm(): void;
}) {
  const t = leaveCopy[locale];
  if (!view.available && view.status === 'idle') return null;
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" onPress={action} style={styles.button}><Text>{label}</Text></Pressable>;
  return <View style={styles.panel}>
    <Text style={styles.title}>{t.title}</Text>
    {view.status === 'idle' && button(t.begin, onBegin)}
    {view.status === 'confirming' && <>
      <Text>{t.consequences}</Text>
      {button(t.cancel, onCancel)}{button(t.confirm, onConfirm)}
    </>}
    {view.status === 'pending' && <Text accessibilityLiveRegion="polite">{t.pending}</Text>}
    {view.status === 'retry' && <><Text accessibilityLiveRegion="polite">{t.unknown}</Text>{button(t.retry, onConfirm)}</>}
    {view.status === 'closed' && <Text accessibilityLiveRegion="polite">{t.closed}</Text>}
    {view.status === 'unavailable' && <Text accessibilityLiveRegion="polite">{t.unavailable}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  panel: { padding: 16, gap: 12, backgroundColor: colors.surface },
  title: { fontWeight: '600', fontSize: 18 },
  button: { paddingVertical: 14, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.muted, borderRadius: 12 },
});
