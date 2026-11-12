import { Button, Text, View } from 'react-native';
import type { DisplayMessage, ReplySelection } from '../chat/reply-view';
export const replyCopy = {
  ru: { reply: 'Ответить на сообщение', original: 'Открыть исходное сообщение', selected: 'Ответ на сообщение', author: 'Автор', cancel: 'Отменить выбор ответа', detail: 'Исходное сообщение', close: 'Закрыть исходное сообщение', deleted: 'Сообщение удалено', loading: 'Исходное сообщение загружается…', pending: 'Повтор отправит ответ на исходную выбранную цель, даже если выбор изменён.', limit: 'Достигнут предел защитной памяти версий сообщений. Чат приостановлен. Черновик сохранён; для продолжения явно выйдите и войдите снова.', reference: 'Ответ на', unavailable: 'Выбранная цель недоступна. Черновик сохранён.' },
  en: { reply: 'Reply to message', original: 'Open original message', selected: 'Replying to message', author: 'Author', cancel: 'Cancel reply selection', detail: 'Original message', close: 'Close original message', deleted: 'Message deleted', loading: 'Loading original message…', pending: 'Retry replies to the original target even if your selection has changed.', limit: 'The message-version safety memory limit was reached. Chat is suspended and your draft is retained. Explicitly sign out and sign in again to continue.', reference: 'Reply to', unavailable: 'The selected target is unavailable. Your draft is retained.' },
};
export type ReplyPanelProps = {
  locale: 'ru' | 'en'; target?: ReplySelection; detail?: DisplayMessage; loading?: boolean;
  suspended?: boolean; onCancel?: () => void; onClose?: () => void; onSelect?: (id: string) => void;
};
export function ChatReplyPanel({ locale, target, detail, loading, suspended, onCancel, onClose, onSelect }: ReplyPanelProps) {
  const t = replyCopy[locale];
  return <View>
    {suspended && <Text accessibilityRole="alert">{t.limit}</Text>}
    {target && <View><Text>{t.selected}: {target.id}</Text><Text>{t.author}: {target.senderId}</Text>
      <Text>{target.preview}</Text>{onCancel && <Button title={t.cancel} onPress={onCancel} />}</View>}
    {loading && <Text>{t.loading}</Text>}
    {detail && <View><Text>{t.detail}: {detail.id}</Text><Text>{t.author}: {detail.senderId}</Text>
      <Text selectable>{detail.body === null ? t.deleted : detail.body}</Text>
      {detail.body !== null && onSelect && <Button title={`${t.reply}: ${detail.id}`} disabled={suspended} onPress={() => onSelect(detail.id)} />}
      {onClose && <Button title={t.close} onPress={onClose} />}</View>}
  </View>;
}
