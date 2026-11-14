import { Button, Text, View } from 'react-native';
import type { DeleteState } from './chat-delete';
export const deleteCopy = {
  ru: { alreadyDeleted: 'Сообщение уже удалено для обоих.', own: 'Ваше сообщение', sent: 'Отправлено', select: 'Удалить для обоих', confirm: 'Подтвердить удаление для обоих', cancel: 'Не удалять',
    notice: 'Удаление нельзя отменить. Текст исчезнет для обоих. Ответы останутся без исходного текста. Партнёру нужно обновить чат: мгновенной синхронизации пока нет.',
    unknown: 'Результат удаления неизвестен. Повтор проверит ту же команду, отмена уже не гарантируется.',
    retry: 'Повторить то же удаление', sending: 'Удаление проверяется…', deleted: 'Сообщение удалено для обоих.',
    error: 'Удаление не подтверждено. Обновите чат перед новым выбором.' },
  en: { alreadyDeleted: 'Message already deleted for both.', own: 'Your message', sent: 'Sent', select: 'Delete for both', confirm: 'Confirm deletion for both', cancel: 'Keep message',
    notice: 'Deletion cannot be undone. The text disappears for both people. Replies remain without the original text. Your partner must refresh the chat; real-time sync is not available yet.',
    unknown: 'The deletion outcome is unknown. Retry checks the same command; cancellation is no longer guaranteed.',
    retry: 'Retry the same deletion', sending: 'Checking deletion…', deleted: 'Message deleted for both.',
    error: 'Deletion was not confirmed. Refresh the chat before selecting again.' },
};
export function ChatDeletePanel({ locale, state, onConfirm, onCancel, onRetry }: {
  locale: 'ru' | 'en'; state?: DeleteState; onConfirm?: (token: string) => void;
  onCancel?: () => void; onRetry?: () => void;
}) {
  const t = deleteCopy[locale], confirmation = state?.confirmation;
  return <View>
    {confirmation && <View><Text>{t.own} #{confirmation.seq}</Text><Text>{t.sent}: {confirmation.createdAt}</Text>
      <Text>{confirmation.messageId}</Text><Text>{t.notice}</Text>
      <Button title={t.confirm} onPress={() => onConfirm?.(confirmation.token)} />
      <Button title={t.cancel} onPress={onCancel} /></View>}
    {state?.pendingId && <Text>{t.select}: {state.pendingId}</Text>}
    {state?.status === 'unknown' && <View><Text accessibilityRole="alert">{t.unknown}</Text>
      <Button title={t.retry} onPress={onRetry} /></View>}
    {state?.status === 'sending' && <Text>{t.sending}</Text>}
    {state?.status === 'hidden' && <Text>{locale === 'ru' ? 'Удаление было выполнено. Сообщение скрыто в вашем чате.' : 'Deletion was committed. The message is hidden in your chat.'}</Text>}
    {state?.status === 'deleted' && <Text>{t.deleted}</Text>}
    {state?.status === 'error' && <Text accessibilityRole="alert">{state.error === 'message_deleted' ? t.alreadyDeleted : t.error}</Text>}
  </View>;
}
