import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { LoveWordsActions } from './love-words';
const copy = {
    ru: { title: 'Наш словарь', notice: 'Слова и пояснения после сохранения видны обоим. Оба могут добавлять записи; менять и удалять запись может только её автор.',
        load: 'Обновить весь словарь', unchecked: 'Полный список сейчас не подтверждён. Обновите словарь вручную.', checked: 'Полный список проверен.', asOf: 'Последнее полное обновление:',
        limit: 'Технический предел тестовой версии: 100 записей за всё время, включая удалённые. Это не тариф. Удаление не освобождает место; существующие записи можно редактировать.',
        remaining: 'Осталось мест по известным данным:', empty: 'В проверенном словаре пока нет слов.', author: 'Автор:', you: 'Вы', partner: 'Партнёр',
        createTitle: 'Новое слово', editTitle: 'Изменение своего слова', word: 'Слово (до 120 символов)', meaning: 'Значение (необязательно, до 1000 символов)', saidWhen: 'Когда говорим (необязательно, до 1000 символов)',
        publish: 'Сохранить новое слово для обоих', save: 'Сохранить изменения для обоих', cancelCreate: 'Отменить ввод нового слова', cancelEdit: 'Отменить редактирование', edit: 'Изменить', remove: 'Удалить',
        confirm: 'Удалить это слово из словаря для обоих?', confirmRemove: 'Да, удалить для обоих', keep: 'Нет, оставить',
        retryButton: 'Повторить ту же команду', pending: 'Команда уже отправлена; результат ещё не подтверждён. Новый текст в форме не меняет повторяемую команду.',
        ram: 'Черновики только в памяти. Отмена очищает форму, но не отменяет уже отправленную команду. Проверка ручная, без синхронизации в реальном времени.',
        changedDraft: 'Запись изменилась. Ваш несохранённый черновик остался здесь; отмените редактирование или заново откройте актуальную запись перед сохранением.',
        deletedDraft: 'Запись удалена. Ваш несохранённый черновик остался здесь; отмените редактирование. Сохранить изменения удалённой записи нельзя.',
        idle: '', saving: 'Сохраняем…', retry: 'Результат неизвестен.', saved: 'Команда подтверждена. Остальные записи требуют ручного обновления.', invalid: 'Проверьте поля.',
        conflict: 'Запись изменилась. Обновите словарь перед следующим действием.', unavailable: 'Словарь недоступен.', capacityReached: 'Достигнут технический предел записей.', error: 'Не удалось подтвердить состояние словаря.' },
    en: { title: 'Our dictionary', notice: 'Saved words and explanations are visible to both. Either member can add entries; only the author can edit or delete an entry.',
        load: 'Refresh entire dictionary', unchecked: 'The full list is not currently confirmed. Refresh the dictionary manually.', checked: 'Full list checked.', asOf: 'Last full refresh:',
        limit: 'Technical test limit: 100 lifetime entries, including deleted entries. This is not a pricing tier. Deletion does not free capacity; existing entries can still be edited.',
        remaining: 'Remaining capacity in known data:', empty: 'No words in the checked dictionary yet.', author: 'Author:', you: 'You', partner: 'Partner',
        createTitle: 'New word', editTitle: 'Edit your word', word: 'Word (up to 120 characters)', meaning: 'Meaning (optional, up to 1000 characters)', saidWhen: 'When we say it (optional, up to 1000 characters)',
        publish: 'Save new word for both', save: 'Save changes for both', cancelCreate: 'Cancel new word', cancelEdit: 'Cancel editing', edit: 'Edit', remove: 'Delete',
        confirm: 'Delete this word from the dictionary for both?', confirmRemove: 'Yes, delete for both', keep: 'No, keep it',
        retryButton: 'Retry same command', pending: 'A command was sent; its outcome is not confirmed yet. New form text does not change the command being retried.',
        ram: 'Drafts are memory-only. Cancel clears a form but does not undo an already submitted command. Manual refresh, not real-time sync.',
        changedDraft: 'This entry changed. Your unsaved draft remains here; cancel or reopen the current entry before saving.',
        deletedDraft: 'This entry was deleted. Your unsaved draft remains here; cancel editing. Changes to a deleted entry cannot be saved.',
        idle: '', saving: 'Saving…', retry: 'Outcome unknown.', saved: 'Command confirmed. Other entries still need manual refresh.', invalid: 'Check the fields.',
        conflict: 'Entry changed. Refresh the dictionary before the next action.', unavailable: 'Dictionary unavailable.', capacityReached: 'Technical entry limit reached.', error: 'Could not confirm dictionary state.' },
};
export function LoveWordsPanel({ controller, locale, userId }: {
    controller: LoveWordsActions;
    locale: 'ru' | 'en';
    userId?: string;
}) {
    const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [deletion, setDeletion] = useState<{
        id: string;
        version: number;
        actor: string;
    } | null>(null);
    if (!view.available)
        return null;
    const actor = userId ?? view.userId;
    const t = copy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
    const words = view.words.filter(entry => entry.state === 'active');
    const confirm = deletion && deletion.actor === actor && words.find(entry => entry.id === deletion.id && entry.authorId === actor && entry.version === deletion.version);
    const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
    const fields = (editing: boolean) => {
        const data = editing ? view.editor!.fields : view.create;
        return (['word', 'meaning', 'saidWhen'] as const).map(key => <TextInput key={key} accessibilityLabel={`${editing ? t.editTitle : t.createTitle}: ${t[key]}`} value={data[key]} onChangeText={value => editing ? controller.setEditField(key, value) : controller.setCreateField(key, value)} multiline={key !== 'word'} autoCorrect={false} maxLength={key === 'word' ? 240 : 2000} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>);
    };
    return <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
  <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
  {button(t.load, () => { void controller.load(); }, view.busy)}
  <Text>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text>{t.asOf} {view.checkedAt}</Text>}
  <Text>{t.limit}</Text><Text>{t.remaining} {Math.max(0, view.capacity - view.used)}</Text>
  {view.checked && words.length === 0 && <Text>{t.empty}</Text>}
  {words.map((entry, index) => <View key={entry.id} style={{ paddingVertical: 8, gap: 4 }}>
   <Text selectable>{entry.word}</Text>{entry.meaning !== '' && <Text selectable>{entry.meaning}</Text>}{entry.saidWhen !== '' && <Text selectable>{entry.saidWhen}</Text>}
   <Text>{t.author} {entry.authorId === actor ? t.you : t.partner}</Text>
   {entry.authorId === actor && <View>{button(`${t.edit} ${index + 1}`, () => controller.beginEdit(entry.id), blocked)}
    {button(`${t.remove} ${index + 1}`, () => setDeletion({ id: entry.id, version: entry.version, actor: entry.authorId }), blocked)}</View>}
  </View>)}
  {confirm && <View><Text>{t.confirm}</Text><Text selectable>{confirm.word}</Text>
   {button(t.confirmRemove, () => { void controller.remove(confirm.id, true); setDeletion(null); }, blocked)}{button(t.keep, () => setDeletion(null))}</View>}
  <Text accessibilityRole="header">{t.createTitle}</Text>{fields(false)}
  {button(t.publish, () => { void controller.create(); }, blocked || view.used >= view.capacity)}{button(t.cancelCreate, () => controller.cancelCreate())}
  {view.editor && <View><Text accessibilityRole="header">{t.editTitle}</Text>{fields(true)}
   {view.editor.stale && <Text accessibilityLiveRegion="polite">{view.editor.stale === 'changed' ? t.changedDraft : t.deletedDraft}</Text>}
   {button(t.save, () => { void controller.saveEdit(); }, blocked || !!view.editor.stale)}{button(t.cancelEdit, () => controller.cancelEdit())}</View>}
  {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && button(t.retryButton, () => { void controller.retry(); }, view.busy)}
  <Text accessibilityLiveRegion="polite">{view.status === 'limit' ? t.capacityReached : t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.ram}</Text>
 </ScrollView>;
}
