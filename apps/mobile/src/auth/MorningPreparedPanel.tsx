import { Button, Text, TextInput, View } from 'react-native';
import type { MorningSlot } from './morning-model';
import type { PreparedEditorView, createMorningPreparedController } from './morning-prepared';
export const preparedCopy = {
  ru: { begin: 'Изменить подготовленное утреннее письмо', title: 'Личный черновик правки утреннего письма',
    notice: 'Можно изменить только свой подготовленный текст до назначенного момента. Срок проверяет сервер. После открытия по сроку правка запрещена. Отменить само письмо нельзя.',
    save: 'Сохранить текст письма', cancel: 'Отменить правку письма', reload: 'Загрузить текущий текст письма', retry: 'Повторить ту же правку письма',
    closed: 'Срок правки завершён. Новые изменения недоступны; черновик не отправляется автоматически.', conflict: 'Версия изменилась. Загрузите текущий текст; ваш черновик сохранится.',
    preserved: 'Личный черновик сохранён отдельно. Проверьте его перед новым сохранением.',
    pending: 'Результат пока неизвестен. Повтор использует ту же команду, а не новую правку.', saved: 'Сохранение подтверждено сервером.',
    error: 'Правка не выполнена. Черновик сохранён.', cancelFirst: 'Сначала явно отмените текущую правку. Её черновик сохранён.' },
  en: { begin: 'Edit prepared morning letter', title: 'Private morning letter edit draft',
    notice: 'Only your prepared text can be edited before the scheduled instant, checked by the server. Once the release time is reached, edits are forbidden. The letter cannot be cancelled.',
    save: 'Save letter text', cancel: 'Cancel letter edit', reload: 'Load current letter text', retry: 'Retry the same letter edit',
    closed: 'The editing deadline has passed. New edits are unavailable; the draft is never sent automatically.', conflict: 'The version changed. Load current text; your draft will be preserved.',
    preserved: 'Your private draft was kept separately. Review it before saving again.',
    pending: 'The outcome is unknown. Retry uses the same command, not a new edit.', saved: 'The server confirmed the save.',
    error: 'The edit did not complete. Your draft is preserved.', cancelFirst: 'Explicitly cancel the current edit first. Its draft is preserved.' },
};
type Actions = ReturnType<typeof createMorningPreparedController>['actions'];
export function MorningPreparedPanel({ locale, selected, view, actions }: {
  locale: 'ru' | 'en'; selected: MorningSlot | null; view: PreparedEditorView; actions: Actions;
}) {
  if (!view.available) return null;
  const t = preparedCopy[locale], uncertain = view.status === 'unknown' || view.status === 'sending';
  return <View>
    {selected?.prepared && selected.state === 'sealed' && <Button title={t.begin}
      disabled={view.busy || uncertain || !!view.target} onPress={() => { void actions.begin(selected); }} />}
    {view.target && <View>
      <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
      <Text>{view.target.localDate} {view.target.localTime} · {view.target.timezone} {view.target.offset} · UTC {view.target.releaseAt}</Text>
      <TextInput accessibilityLabel={t.title} multiline maxLength={16000} value={view.draft} onChangeText={actions.setDraft} />
      <Button title={t.save} disabled={view.busy || uncertain || view.needsReload || view.status === 'closed'} onPress={() => { void actions.save(); }} />
      <Button title={t.reload} disabled={view.busy || uncertain || view.status === 'closed'} onPress={() => { void actions.reload(); }} />
      <Button title={t.cancel} disabled={uncertain} onPress={actions.cancel} />
      {view.status === 'closed' && <Text>{t.closed}</Text>}
      {view.status === 'conflict' && <Text>{t.conflict}</Text>}
      {view.status === 'saved' && <Text>{t.saved}</Text>}
      {view.draftPreserved && <Text>{t.preserved}</Text>}
      {view.status === 'unknown' && <View><Text>{t.pending}</Text><Button title={t.retry} disabled={view.busy} onPress={() => { void actions.retry(); }} /></View>}
      {view.error && <Text accessibilityRole="alert">{view.error === 'cancel_edit_first' ? t.cancelFirst : t.error}</Text>}
    </View>}
  </View>;
}
