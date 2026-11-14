import { Button, Text, TextInput, View } from 'react-native';
import type { MorningView, createMorningsController } from './mornings';
export const morningCopy = {
  ru: { title: 'Утренние письма', notice: 'Отдельные письма к выбранному утру. Уведомлений и автоматической отправки нет. Текст не защищён сквозным шифрованием.',
    preference: 'Моё время получения', zone: 'Мой часовой пояс IANA', time: 'Моё время HH:mm', save: 'Сохранить моё время',
    refresh: 'Обновить утренние письма', older: 'Более ранние утра', newer: 'Более поздние утра', latest: 'Последние утра', oldest: 'Первые утра',
    date: 'Дата утра партнёра YYYY-MM-DD', assign: 'Назначить утро партнёру', missing: 'Партнёр ещё не выбрал время получения.',
    choice: 'Выберите смещение явно: это время повторяется.', gap: 'Дата или время некорректны либо такого местного времени не существует. Проверьте дату и часовой пояс.',
    confirm: 'Подтвердить', cancel: 'Отменить подтверждение', assignment: 'Будет создано новое утро. Смена предпочтений не сдвинет его. Изменить или отменить назначение в этой версии нельзя.',
    fill: 'Подготовить текст один раз', body: 'Текст утреннего письма', fillNotice: 'Текст можно заполнить только один раз до указанного момента. После подготовки автор может изменить текст до назначенного момента в отдельной форме. Отменить письмо нельзя.',
    sealed: 'До назначенного момента закрыто', available: 'Готово к открытию', missed: 'Утро пропущено: текст не был подготовлен вовремя',
    empty: 'Утра не назначены. Это не пропущенные письма.', select: 'Выбрать утро', prepared: 'Ваш текст подготовлен', unprepared: 'Ваш текст ещё не подготовлен',
    open: 'Открыть утреннее письмо', reread: 'Перечитать утреннее письмо', last: 'Показать последнее готовое входящее',
    openNotice: 'После явного открытия письмо останется доступным вам. Партнёру не показывается, открыли ли вы его.',
    retry: 'Повторить ту же попытку', pending: 'Результат попытки пока не подтверждён. Повтор не создаёт новую команду.',
    clear: 'Очистить черновик утра', saved: 'Сохранённые в памяти черновики', close: 'Закрыть утреннее письмо',
    error: 'Действие не выполнено. Черновики сохранены. Обновите данные или повторите ту же попытку.',
    bounds: 'Даты 2000–2100; назначение от 1 минуты до 366 дней вперёд. При пропуске часа дата не сдвигается автоматически.',
    draftLimit: 'В памяти уже 30 черновиков. Очистите один явно; существующие черновики не удалены.' },
  en: { title: 'Morning letters', notice: 'Separate letters for a chosen morning. No notifications or automatic sending. Text is not end-to-end encrypted.',
    preference: 'My receiving time', zone: 'My IANA time zone', time: 'My time HH:mm', save: 'Save my receiving time',
    refresh: 'Refresh morning letters', older: 'Earlier mornings', newer: 'Later mornings', latest: 'Latest mornings', oldest: 'Oldest mornings',
    date: 'Partner morning date YYYY-MM-DD', assign: 'Assign a morning for my partner', missing: 'Your partner has not chosen a receiving time yet.',
    choice: 'Choose an offset explicitly: this local time occurs twice.', gap: 'The date or time is invalid, or this local time does not exist. Check the date and time zone.',
    confirm: 'Confirm', cancel: 'Cancel confirmation', assignment: 'A new morning will be assigned. Preference changes will not move it. This version cannot edit or cancel an assignment.',
    fill: 'Prepare text once', body: 'Morning letter text', fillNotice: 'Text can be filled once, before the shown instant. After preparation the author can edit before the scheduled instant in a separate form. The letter cannot be cancelled.',
    sealed: 'Closed until its scheduled instant', available: 'Available to open', missed: 'Missed morning: text was not prepared in time',
    empty: 'No mornings assigned. This does not mean missed letters.', select: 'Select morning', prepared: 'Your text is prepared', unprepared: 'Your text is not prepared yet',
    open: 'Open morning letter', reread: 'Reread morning letter', last: 'Show latest available incoming morning',
    openNotice: 'After you explicitly open it, the letter remains readable for you. Your partner is not shown whether you opened it.',
    retry: 'Retry the same attempt', pending: 'The attempt is not confirmed yet. Retry keeps the same command.',
    clear: 'Clear morning draft', saved: 'Drafts kept in memory', close: 'Close morning letter',
    error: 'The action did not complete. Drafts are preserved. Refresh or retry the same attempt.',
    bounds: 'Dates 2000–2100; assign 1 minute to 366 days ahead. A skipped local time is never silently shifted.',
    draftLimit: 'There are already 30 drafts in memory. Clear one explicitly; existing drafts were not removed.' },
};
type Actions = ReturnType<typeof createMorningsController>['actions'];
export function MorningsPanel({ locale, view, actions }: { locale: 'ru' | 'en'; view: MorningView; actions: Actions }) {
  if (!view.available) return null;
  const t = morningCopy[locale], selected = view.selected, partner = view.preferences.find(p => p.userId !== view.userId);
  const choice = view.choices.find(c => c.offset === view.offset);
  const snapshot = (slot: { localDate: string; localTime: string; timezone: string; offset: string; releaseAt: string }) => `${slot.localDate} ${slot.localTime} · ${slot.timezone} ${slot.offset} · UTC ${slot.releaseAt}`;
  return <View>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text><Text>{t.bounds}</Text>
    <Text>{t.preference}</Text>
    <TextInput accessibilityLabel={t.zone} value={view.preferenceForm.timezone} maxLength={100} onChangeText={timezone => actions.setPreference({ timezone })} />
    <TextInput accessibilityLabel={t.time} value={view.preferenceForm.localTime} maxLength={5} onChangeText={localTime => actions.setPreference({ localTime })} />
    <Button title={t.save} disabled={view.busy || !!view.pendingId} onPress={() => { void actions.savePreference(); }} />
    {view.preferences.map(p => <Text key={p.userId}>{p.userId === view.userId ? t.preference : (locale === 'ru' ? 'Время партнёра' : 'Partner receiving time')}: {p.localTime} · {p.timezone}</Text>)}
    <TextInput accessibilityLabel={t.date} value={view.localDate} maxLength={10} onChangeText={actions.setLocalDate} />
    {view.choices.length > 1 && <Text>{t.choice}</Text>}
    {view.choices.length > 1 && view.choices.map(c => <Button key={c.offset} title={`${c.offset} · UTC ${c.releaseAt}`} onPress={() => actions.chooseOffset(c.offset)} />)}
    {view.localDate && !view.choices.length && <Text>{partner ? t.gap : t.missing}</Text>}
    {choice && <Text>{view.localDate} {partner?.localTime} · {partner?.timezone} {view.offset} · UTC {choice.releaseAt}</Text>}
    <Button title={t.assign} disabled={view.busy || !!view.pendingId || !choice} onPress={actions.requestAssignment} />
    <Button title={t.refresh} disabled={view.busy} onPress={() => { void actions.list(); }} />
    <Button title={t.oldest} disabled={view.busy} onPress={() => { void actions.oldest(); }} /><Button title={t.latest} disabled={view.busy} onPress={() => { void actions.latest(); }} />
    <Button title={t.older} disabled={view.busy || !view.history?.hasOlder} onPress={() => { void actions.older(); }} /><Button title={t.newer} disabled={view.busy || !view.history?.hasNewer} onPress={() => { void actions.newer(); }} />
    {view.history && !view.slots.length && <Text>{t.empty}</Text>}
    {view.slots.map(slot => <View key={slot.id}><Text>{snapshot(slot)}</Text><Text>{t[slot.state]}</Text><Button title={`${t.select}: ${slot.localDate} ${slot.localTime}`} onPress={() => actions.selectSlot(slot.id)} /></View>)}
    {!!view.savedDraftSlots.length && <Text>{t.saved}</Text>}
    {view.savedDraftSlots.map(slot => <Button key={slot.id} title={`${t.saved}: ${slot.localDate} ${slot.localTime}`} onPress={() => actions.selectSlot(slot.id)} />)}
    {view.history?.lastAvailableId && <Button title={t.last} disabled={view.busy} onPress={() => { void actions.openLastAvailable(); }} />}
    {selected && <View><Text>{snapshot(selected)}</Text><Text>{t[selected.state]}</Text>
      {'prepared' in selected && <View><Text>{selected.prepared ? t.prepared : t.unprepared}</Text>
        <TextInput multiline accessibilityLabel={t.body} value={view.draft} maxLength={16000} onChangeText={actions.setDraft} />
        <Button title={t.clear} onPress={actions.clearDraft} />
        <Button title={t.fill} disabled={view.busy || !!view.pendingId || selected.prepared || selected.state !== 'sealed'} onPress={actions.requestFill} /></View>}
      {selected.state === 'available' && <View><Text>{t.openNotice}</Text><Button title={selected.openedAt ? t.reread : t.open} disabled={view.busy || !!view.pendingId} onPress={() => { void actions.open(selected.id); }} /></View>}
    </View>}
    {view.confirmation && <View><Text>{view.confirmation.kind === 'assign' ? t.assignment : t.fillNotice}</Text>
      {view.confirmation.slot && <Text>{snapshot(view.confirmation.slot)}</Text>}
      {view.confirmation.preference && <Text>{view.confirmation.localDate} {view.confirmation.preference.localTime} · {view.confirmation.preference.timezone} {view.confirmation.offset} · UTC {view.confirmation.releaseAt}</Text>}
      <Button title={t.confirm} onPress={() => { void actions.confirm(view.confirmation!.token); }} /><Button title={t.cancel} onPress={actions.cancelConfirmation} /></View>}
    {view.pendingId && <View><Text>{t.pending}</Text><Button title={t.retry} disabled={view.busy} onPress={() => { void actions.retry(); }} /></View>}
    {view.error && <Text accessibilityRole="alert">{view.error === 'draft_limit' ? t.draftLimit : t.error}</Text>}
    {view.opened && <Text selectable>{view.opened.body}</Text>}
    {(selected || view.opened) && <Button title={t.close} onPress={actions.close} />}
  </View>;
}
