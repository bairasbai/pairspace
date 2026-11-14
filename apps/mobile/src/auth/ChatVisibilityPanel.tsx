import { Button, Text, View } from 'react-native';
import type { VisibilityView } from './chat-visibility';
export const visibilityCopy = {
    ru: { hide: 'Скрыть только у меня', restore: 'Вернуть в мой чат', confirm: 'Подтвердить изменение видимости', cancel: 'Отмена',
        notice: 'Это меняет только ваш чат. Партнёр не получает уведомлений и продолжает видеть свою переписку. Скрытое можно вернуть; удалённый для обоих текст не восстановится.',
        title: 'Скрытые сообщения', latest: 'Последние скрытые', oldest: 'Самые ранние скрытые', older: 'Предыдущие скрытые', newer: 'Следующие скрытые',
        changed: 'Видимость изменилась на этом или другом устройстве. Обновите чат явно. Старые тексты временно скрыты; новый приватный черновик сохранён.',
        unknown: 'Подтверждение не получено. Повтор проверит ту же команду.', retry: 'Повторить изменение видимости', saved: 'Видимость проверена. Для чтения явно обновите чат.',
        hiddenCommit: 'Исходная команда была выполнена. Сообщение сейчас скрыто; его текст не показан.', deleted: 'Текст удалён для обоих', empty: 'Скрытых сообщений в этом окне нет.', error: 'Не удалось проверить видимость. Обновите список или повторите запрос.' },
    en: { hide: 'Hide only for me', restore: 'Restore to my chat', confirm: 'Confirm visibility change', cancel: 'Cancel',
        notice: 'This changes only your chat. Your partner is not notified and keeps their own conversation. Hidden messages can be restored; text deleted for both cannot be recovered.',
        title: 'Hidden messages', latest: 'Latest hidden', oldest: 'Oldest hidden', older: 'Previous hidden', newer: 'Next hidden',
        changed: 'Visibility changed on this or another device. Explicitly refresh the chat. Old text is hidden for now; your new private draft is retained.',
        unknown: 'Confirmation was not received. Retry checks the same command.', retry: 'Retry visibility change', saved: 'Visibility checked. Explicitly refresh the chat to read it.',
        hiddenCommit: 'The original command was committed. The message is now hidden; its text is not displayed.', deleted: 'Text deleted for both', empty: 'No hidden messages in this window.', error: 'Could not verify visibility. Refresh the list or retry.' },
};
export function ChatVisibilityPanel({ locale, view, onConfirm, onCancel, onRetry, onRestore, onLatest, onOldest, onOlder, onNewer }: {
    locale: 'ru' | 'en';
    view: VisibilityView;
    onConfirm(token: string): void;
    onCancel(): void;
    onRetry(): void;
    onRestore(id: string): void;
    onLatest(): void;
    onOldest(): void;
    onOlder(): void;
    onNewer(): void;
}) {
    const t = visibilityCopy[locale], confirmation = view.confirmation;
    return <View><Text>{t.title}</Text><Text>{t.notice}</Text>
        <Button title={t.latest} onPress={onLatest}/><Button title={t.oldest} onPress={onOldest}/>
        {confirmation && <View><Text>{confirmation.hidden ? t.hide : t.restore}: #{confirmation.seq} {confirmation.createdAt}</Text>
            <Button title={t.confirm} onPress={() => onConfirm(confirmation.token)}/><Button title={t.cancel} onPress={onCancel}/></View>}
        {view.status === 'unknown' && <View><Text accessibilityRole="alert">{t.unknown}</Text><Text>{view.pendingId}</Text><Button title={t.retry} onPress={onRetry}/></View>}
        {view.status === 'saved' && <Text>{t.saved}</Text>}
        {view.status === 'error' && <Text accessibilityRole="alert">{t.error}</Text>}
        {view.history && <View>
            {!view.history.messages.length && <Text>{t.empty}</Text>}
            {view.history.messages.map(message => <View key={message.id}>
                <Text>#{message.seq} {message.createdAt}</Text><Text>{message.senderId}</Text>
                {message.deletedAt !== null && <Text>{t.deleted}</Text>}
                <Button title={`${t.restore}: ${message.id}`} disabled={!!view.pendingId} onPress={() => onRestore(message.id)}/>
            </View>)}
            <Button title={t.older} disabled={!view.history.hasOlder} onPress={onOlder}/>
            <Button title={t.newer} disabled={!view.history.hasNewer} onPress={onNewer}/>
        </View>}
    </View>;
}
