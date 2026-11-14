import { Button, Text, View } from 'react-native';
import type { ReconciliationView } from './chat-reconciliation';
export const reconciliationCopy = {
  ru: { check: 'Сверить сообщения', busy: 'Сверяем текущее окно…',
    notice: 'Сверяется только текущее окно, открытый оригинал и выбранная связь ответа. Это не обновление в реальном времени. Черновики сохраняются.',
    newer: 'Есть более поздние сообщения. Текущее место сохранено.', latest: 'Перейти к последним сообщениям',
    attachment: 'Оригинал ответа недоступен. Текст сохранён, отправка заблокирована. Уберите связь явно, чтобы отправить обычное сообщение.', remove: 'Убрать недоступную связь ответа',
    error: 'Сверка не выполнена. Повторите явно.', visibility: 'Доступность сообщений изменилась. Откройте окно заново.' },
  en: { check: 'Check messages', busy: 'Checking this window…',
    notice: 'Only this window, the opened original and the selected reply target are checked. This is not real-time updating. Drafts are preserved.',
    newer: 'Later messages are available. Your position is preserved.', latest: 'Go to latest messages',
    attachment: 'The reply original is unavailable. Your text is preserved and sending is blocked. Remove the attachment explicitly to send a plain message.', remove: 'Remove unavailable reply attachment',
    error: 'Check failed. Retry explicitly.', visibility: 'Message visibility changed. Open the window again.' },
};
export function ChatReconciliationPanel({ locale, view, onCheck, onLatest, attachmentUnavailable, onRemoveAttachment }: {
  locale: 'ru' | 'en'; view: ReconciliationView; onCheck(): void; onLatest(): void; attachmentUnavailable?: boolean; onRemoveAttachment?(): void;
}) {
  const text = reconciliationCopy[locale];
  return <View>
    <Text>{text.notice}</Text>
    {attachmentUnavailable && <View><Text accessibilityRole="alert">{text.attachment}</Text><Button title={text.remove} onPress={onRemoveAttachment} /></View>}
    <Button title={text.check} disabled={view.status === 'loading'} onPress={onCheck} />
    {view.status === 'loading' && <Text>{text.busy}</Text>}
    {view.status === 'error' && <Text accessibilityRole="alert">{view.error === 'visibility_changed' ? text.visibility : text.error}</Text>}
    {view.hasNewMessages && <View><Text>{text.newer}</Text><Button title={text.latest} onPress={onLatest} /></View>}
  </View>;
}
