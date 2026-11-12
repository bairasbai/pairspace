import { Button, Text, TextInput, View } from 'react-native';
import type { EditState } from './chat-edit';
export const editCopy = {
    ru: { edit: 'Изменить сообщение', edited: 'Изменено', draft: 'Новый текст сообщения', save: 'Сохранить изменение', cancel: 'Закрыть редактор', retry: 'Повторить то же изменение', reload: 'Загрузить текущую версию', notice: 'Изменение будет видно обоим после обновления чата. Ответы сохраняют ссылку на это сообщение.', conflict: 'Черновик сохранён. Загрузите текущую версию перед новым сохранением.', unknown: 'Результат неизвестен. Повтор использует исходный текст и версию.', deleted: 'Сообщение удалено. Сохранение невозможно; новый несохранённый текст можно скопировать.', saved: 'Текст сообщения сохранён.' },
    en: { edit: 'Edit message', edited: 'Edited', draft: 'Updated message text', save: 'Save change', cancel: 'Close editor', retry: 'Retry the same edit', reload: 'Load current version', notice: 'Both people see the change after refreshing the chat. Replies keep their link to this message.', conflict: 'Your draft is retained. Load the current version before saving again.', unknown: 'The outcome is unknown. Retry uses the original text and version.', deleted: 'The message is deleted. Saving is disabled; you can copy any new unsaved text.', saved: 'Message text saved.' },
};
export function ChatEditPanel({ locale, state, onDraft, onSave, onCancel, onRetry, onReload }: {
    locale: 'ru' | 'en';
    state?: EditState;
    onDraft?: (text: string) => void;
    onSave?: () => void;
    onCancel?: () => void;
    onRetry?: () => void;
    onReload?: () => void;
}) {
    if (!state?.targetId)
        return null;
    const t = editCopy[locale], pending = state.status === 'sending' || state.status === 'unknown';
    return <View><Text>{t.edit}: {state.targetId}</Text><Text>{t.notice}</Text>
   <TextInput accessibilityLabel={t.draft} value={state.draft} multiline maxLength={16000} onChangeText={onDraft}/>
   {state.status === 'unknown' && <><Text accessibilityRole="alert">{t.unknown}</Text><Button title={t.retry} onPress={onRetry}/></>}
   {state.needsReload && state.status !== 'deleted' && <Text accessibilityRole="alert">{t.conflict}</Text>}
   {state.status === 'deleted' && <Text accessibilityRole="alert">{t.deleted}</Text>}
   {state.status === 'saved' && <Text>{t.saved}</Text>}
   {!pending && state.status !== 'deleted' && <><Button title={t.save} disabled={state.needsReload} onPress={onSave}/>
     <Button title={t.reload} onPress={onReload}/></>}
   {!pending && <Button title={t.cancel} onPress={onCancel}/>}</View>;
}
