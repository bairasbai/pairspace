import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { ScaleActions } from './scale';
const copy = {
    ru: {
        title: 'Шкала дня', notice: 'Добровольная оценка своего дня от 0 до 100, не оценка партнёра и не диагноз. После публикации партнёр видит число, даже если ничего не публикует сам.',
        load: 'Обновить всю историю', checked: 'Полная история проверена.', unchecked: 'Полная история сейчас не подтверждена. Обновите её вручную.', asOf: 'Последнее полное обновление:',
        cap: 'Технический предел тестовой версии: 100 дат на каждого автора, включая снятые публикации. Это не тариф. Записи партнёра не занимают ваши места. При заполненном лимите можно исправлять, снимать и заново публиковать существующие записи.',
        missingNotice: 'Отсутствие опубликованной оценки не равно нулю и не объясняет настроение.',
        remaining: 'Ваших мест осталось по известным данным:', empty: 'В проверенной истории пока нет записей.', noValue: 'Нет опубликованной оценки. Это не ноль и не вывод о настроении.',
        by: 'Автор:', you: 'Вы', partner: 'Партнёр', zoneNotice: 'Одинаковая дата в разных поясах не означает один и тот же момент. Сравнение оценок не выполняется.',
        date: 'Ожидаемая сегодняшняя дата YYYY-MM-DD', timezone: 'Часовой пояс IANA', value: 'Новое значение от 0 до 100',
        dateNotice: 'Укажите дату и пояс явно. Сервер сверит дату с сегодняшней в этом поясе. При несовпадении публикация отклоняется, дата не меняется автоматически.',
        publish: 'Поделиться оценкой за сегодня', cancelCreate: 'Отменить новую оценку', edit: 'Исправить свою оценку', reshare: 'Ввести новую публикацию', remove: 'Снять свою публикацию',
        editValue: 'Исправленное значение от 0 до 100', freshValue: 'Значение новой публикации от 0 до 100', save: 'Сохранить исправление для обоих', shareAgain: 'Поделиться заново', cancelEdit: 'Отменить изменение',
        immutableDate: 'Дата и пояс этой записи не меняются. Исправление старой записи не переносит её на сегодня.',
        stale: 'Запись изменилась. Несохранённое значение осталось в форме; отмените изменение или заново откройте актуальную запись перед сохранением.',
        removeWarning: 'Снять эту оценку с общего просмотра? Уже прочитанные или сохранённые партнёром копии не исчезнут. Дата и пояс записи останутся видны.',
        reshareWarning: 'Опубликовать введённое значение заново для обоих? Это новая публикация, не восстановление прежнего значения.',
        currentInput: 'Сейчас введено:', confirmRemove: 'Подтвердить снятие', confirmShare: 'Подтвердить новую публикацию', cancelConfirm: 'Не подтверждать',
        numeric: 'Только целое число 0–100. Пустое поле не равно нулю. Значение по умолчанию не выбирается.',
        pending: 'Команда отправлена, результат ещё не подтверждён. Новый ввод не меняет повторяемую команду.', retryButton: 'Повторить ту же команду',
        ram: 'Черновики только в памяти. Отмена очищает форму, но не отменяет уже отправленную команду. Нет напоминаний, обязательства публиковать или синхронизации в реальном времени.',
        idle: '', saving: 'Сохраняем…', retry: 'Результат неизвестен.', saved: 'Команда подтверждена. Остальная история требует ручного обновления.', invalid: 'Проверьте целое число, дату и пояс.', conflict: 'Запись изменилась. Обновите историю.', unavailable: 'Шкала недоступна.', limit: 'Ваш технический предел дат достигнут.', dateMismatch: 'Дата не совпала с сегодняшней в выбранном поясе. Проверьте дату и отправьте новую команду явно.', error: 'Не удалось подтвердить состояние истории.',
    },
    en: {
        title: 'Day scale', notice: 'An optional rating of your own day from 0 to 100, not a partner rating or diagnosis. After publication your partner can read it without publishing their own.',
        load: 'Refresh entire history', checked: 'Full history checked.', unchecked: 'The full history is not currently confirmed. Refresh it manually.', asOf: 'Last full refresh:',
        cap: 'Technical test limit: 100 dates per author, including removed publications. This is not a pricing tier. Partner entries do not use your capacity. Existing entries can still be corrected, removed or shared anew at the limit.',
        missingNotice: 'A missing shared rating is not zero and does not explain anyone’s mood.',
        remaining: 'Your remaining capacity in known data:', empty: 'No entries in the checked history yet.', noValue: 'No shared rating. This is not zero and does not imply a mood.',
        by: 'Author:', you: 'You', partner: 'Partner', zoneNotice: 'The same date in different zones does not mean the same instant. Ratings are not compared.',
        date: 'Expected today date YYYY-MM-DD', timezone: 'IANA time zone', value: 'New value from 0 to 100',
        dateNotice: 'Enter the date and zone explicitly. The server checks today in that zone. A mismatch rejects publication instead of silently changing the date.',
        publish: 'Share today’s rating', cancelCreate: 'Cancel new rating', edit: 'Correct your rating', reshare: 'Enter a new publication', remove: 'Remove your publication',
        editValue: 'Corrected value from 0 to 100', freshValue: 'New publication value from 0 to 100', save: 'Save correction for both', shareAgain: 'Share anew', cancelEdit: 'Cancel change',
        immutableDate: 'This entry’s date and zone do not change. Correcting a historical entry does not move it to today.',
        stale: 'This entry changed. Your unsaved value remains in the form; cancel the change or reopen the current entry before saving.',
        removeWarning: 'Remove this rating from shared view? Copies already read or saved by your partner will not disappear. The entry’s date and zone will remain visible.',
        reshareWarning: 'Publish the entered value anew for both? This is a new publication, not restoration of the previous value.',
        currentInput: 'Currently entered:', confirmRemove: 'Confirm removal', confirmShare: 'Confirm new publication', cancelConfirm: 'Do not confirm',
        numeric: 'Whole numbers 0–100 only. Blank is not zero. No default value is selected.',
        pending: 'A command was sent; its outcome is not confirmed yet. New input does not change the command being retried.', retryButton: 'Retry same command',
        ram: 'Drafts are memory-only. Cancel clears a form but does not undo a submitted command. No reminders, obligation to publish or real-time sync.',
        idle: '', saving: 'Saving…', retry: 'Outcome unknown.', saved: 'Command confirmed. Other history still needs manual refresh.', invalid: 'Check the whole number, date and zone.', conflict: 'Entry changed. Refresh the history.', unavailable: 'Day scale unavailable.', limit: 'Your technical date limit is reached.', dateMismatch: 'The date did not match today in the selected zone. Check it and explicitly send a new command.', error: 'Could not confirm history state.',
    },
};
export function ScalePanel({ controller, locale }: {
    controller: ScaleActions;
    locale: 'ru' | 'en';
}) {
    const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [confirmation, setConfirmation] = useState<{
        id: string;
        version: number;
        actor: string | null;
        kind: 'remove' | 'reshare';
    } | null>(null);
    if (!view.available)
        return null;
    const t = copy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
    const editorSlot = view.editor && view.slots.find(slot => slot.id === view.editor!.id);
    const confirming = confirmation && confirmation.actor === view.userId && view.slots.find(slot => slot.id === confirmation.id && slot.version === confirmation.version && slot.authorId === view.userId &&
        (confirmation.kind === 'remove' ? slot.state === 'active' : slot.state === 'removed' && view.editor?.id === slot.id && view.editor.version === slot.version && view.editor.mode === 'reshare' && !view.editor.stale));
    const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
    return <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    {button(t.load, () => { void controller.load(); }, view.busy)}
    <Text>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text>{t.asOf} {view.checkedAt}</Text>}
    <Text>{t.cap}</Text><Text>{t.remaining} {Math.max(0, view.capacityPerAuthor - view.ownUsed)}</Text>
    {view.checked && view.slots.length === 0 && <Text>{t.empty}</Text>}
    <Text>{t.missingNotice}</Text><Text>{t.zoneNotice}</Text>
    {view.slots.map((slot, index) => <View key={slot.id} style={{ paddingVertical: 8, gap: 4 }}>
      <Text>{t.by} {slot.authorId === view.userId ? t.you : t.partner}</Text><Text>{slot.localDate} · {slot.timezone}</Text>
      <Text selectable>{slot.state === 'active' ? String(slot.value) : t.noValue}</Text>
      {slot.authorId === view.userId && <View>
        {button(`${slot.state === 'active' ? t.edit : t.reshare} ${index + 1}`, () => controller.beginEdit(slot.id), blocked)}
        {slot.state === 'active' && button(`${t.remove} ${index + 1}`, () => setConfirmation({ id: slot.id, version: slot.version, actor: view.userId, kind: 'remove' }), blocked)}
      </View>}
    </View>)}
    <Text>{t.dateNotice}</Text>
    <TextInput accessibilityLabel={t.date} value={view.create.expectedDate} onChangeText={value => controller.setCreateField('expectedDate', value)} maxLength={10} autoCapitalize="none" autoCorrect={false} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>
    <TextInput accessibilityLabel={t.timezone} value={view.create.timezone} onChangeText={value => controller.setCreateField('timezone', value)} maxLength={100} autoCapitalize="none" autoCorrect={false} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>
    <Text>{t.numeric}</Text>
    <TextInput accessibilityLabel={t.value} value={view.create.value} onChangeText={value => controller.setCreateField('value', value)} keyboardType="number-pad" maxLength={16} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>
    {button(t.publish, () => { void controller.create(); }, blocked || view.ownUsed >= view.capacityPerAuthor)}{button(t.cancelCreate, controller.cancelCreate)}
    {view.editor && <View>
      <Text>{t.immutableDate}</Text>{editorSlot && <Text>{editorSlot.localDate} · {editorSlot.timezone}</Text>}
      <TextInput accessibilityLabel={view.editor.mode === 'edit' ? t.editValue : t.freshValue} value={view.editor.value} onChangeText={controller.setValue} keyboardType="number-pad" maxLength={16} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>
      {view.editor.stale && <Text accessibilityLiveRegion="polite">{t.stale}</Text>}
      {view.editor.mode === 'edit' ? button(t.save, () => { void controller.save(false); }, blocked || !!view.editor.stale) :
                button(t.shareAgain, () => setConfirmation({ id: view.editor!.id, version: view.editor!.version, actor: view.userId, kind: 'reshare' }), blocked || !!view.editor.stale)}
      {button(t.cancelEdit, controller.cancelEdit)}
    </View>}
    {confirming && confirmation && <View>
      <Text>{confirmation.kind === 'remove' ? t.removeWarning : t.reshareWarning}</Text><Text>{confirming.localDate} · {confirming.timezone}</Text>
      {confirmation.kind === 'reshare' && <Text>{t.currentInput} {view.editor!.value}</Text>}
      {button(confirmation.kind === 'remove' ? t.confirmRemove : t.confirmShare, () => {
                if (confirmation.kind === 'remove')
                    void controller.remove(confirming.id, true);
                else
                    void controller.save(true);
                setConfirmation(null);
            }, blocked)}{button(t.cancelConfirm, () => setConfirmation(null))}
    </View>}
    {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && button(t.retryButton, () => { void controller.retry(); }, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.ram}</Text>
  </ScrollView>;
}
