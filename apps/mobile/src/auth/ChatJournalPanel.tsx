import { Button, Text, View } from 'react-native';
import type { ChatJournalView } from './chat-journal';
export const journalCopy = {
  ru: { title: 'Экспериментальный защищённый черновик', notice: 'Локальный зашифрованный журнал: один черновик и одна попытка отправки. Не история чата. Только восстановление после перезапуска, не резервная копия для переустановки или другого устройства. Работа на настоящем устройстве ещё не подтверждена.',
    check: 'Проверить локальный журнал', restore: 'Восстановить после проверки доступа', flush: 'Повторить локальное сохранение',
    recovery: 'Есть сохранённые данные. Отправка заблокирована до явного восстановления.',
    pending: 'Есть сохранённая попытка отправки. После восстановления её текст скрыт. Повтор использует ту же команду, а не новое сообщение.',
    unsaved: 'Локальное сохранение не подтверждено. Черновик остаётся в памяти; новая отправка не начнётся без сохранения команды.',
    conflict: 'Текущий и сохранённый черновики различаются. Выберите явно: второй черновик будет заменён. До выбора отправка заблокирована.',
    current: 'Оставить текущий, заменить сохранённый', stored: 'Восстановить сохранённый, заменить текущий',
    verify: 'Проверить сохранённую связь ответа', remove: 'Убрать сохранённую связь ответа', target: 'Связь ответа ещё не проверена. Отправка нового сообщения заблокирована; текст сохранён.',
    ready: 'Локальный журнал готов.',
  },
  en: { title: 'Experimental protected draft', notice: 'A local encrypted journal for one draft and one send attempt, not chat history. Restart recovery only, not backup for reinstalling or another device. Real-device operation has not been verified.',
    check: 'Check local journal', restore: 'Restore after access check', flush: 'Retry local save',
    recovery: 'Saved data exists. Sending is blocked until explicit recovery.',
    pending: 'A send attempt is saved. Its text is hidden after recovery. Retry submits the same command, not a new message.',
    unsaved: 'Local saving is not confirmed. Your draft remains in memory; a new send cannot start without saving its command.',
    conflict: 'Current and saved drafts differ. Choose explicitly: the other draft will be replaced. Sending is blocked until you choose.',
    current: 'Keep current and replace saved draft', stored: 'Restore saved and replace current draft',
    verify: 'Verify saved reply attachment', remove: 'Remove saved reply attachment', target: 'The reply attachment is not verified. Sending a new message is blocked; your text is retained.',
    ready: 'Local journal ready.',
  },
};
export function ChatJournalPanel({ locale, view, onCheck, onRestore, onFlush, onConflict, onVerify, onRemove, onRetry, onBeginReset, onCancelReset, onConfirmReset }: {
  locale: 'ru' | 'en'; view: ChatJournalView; onCheck(): void; onRestore(): void; onFlush(): void;
  onBeginReset(): void; onCancelReset(): void; onConfirmReset(token: string): void;
  onConflict(token: string, choice: 'current' | 'stored'): void; onVerify(): void; onRemove(): void; onRetry(): void;
}) {
  if (!view.enabled) return null;
  const t = journalCopy[locale];
  return <View><Text>{t.title}</Text><Text>{t.notice}</Text>
    <Button title={t.check} onPress={onCheck} />
    <Button title={locale === 'ru' ? 'Сбросить локальный журнал' : 'Reset local journal'} onPress={onBeginReset} />
    {view.resetToken && <View><Text>{locale === 'ru' ? 'Черновик и локальная попытка будут потеряны. Уже отправленное сообщение не отменится и не удалится.' : 'The draft and local retry attempt will be lost. An already sent message is not cancelled or deleted.'}</Text>
      <Button title={locale === 'ru' ? 'Отмена сброса' : 'Cancel reset'} onPress={onCancelReset} />
      <Button title={locale === 'ru' ? 'Подтвердить локальный сброс' : 'Confirm local reset'} onPress={() => onConfirmReset(view.resetToken!)} /></View>}
    {view.status === 'recovery' && <><Text>{t.recovery}</Text><Button title={t.restore} onPress={onRestore} /></>}
    {view.status === 'unsaved' && <><Text accessibilityRole="alert">{t.unsaved}</Text><Button title={t.flush} onPress={onFlush} /></>}
    {view.status === 'ready' && <Text>{t.ready}</Text>}
    {view.hasPending && view.status === 'ready' && <><Text>{t.pending}</Text><Button title={locale === 'ru' ? 'Повторить исходную отправку' : 'Retry original send'} onPress={onRetry} /></>}
    {view.status === 'conflict' && view.conflictToken && <><Text accessibilityRole="alert">{t.conflict}</Text>
      <Button title={t.current} onPress={() => onConflict(view.conflictToken!, 'current')} />
      <Button title={t.stored} onPress={() => onConflict(view.conflictToken!, 'stored')} /></>}
    {view.replyNeedsVerification && <><Text>{t.target}</Text><Button title={t.verify} onPress={onVerify} /><Button title={t.remove} onPress={onRemove} /></>}
  </View>;
}
