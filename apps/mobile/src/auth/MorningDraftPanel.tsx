import { Button, Text, TextInput, View } from 'react-native';
import type { MorningSlot } from './morning-model';
import type { MorningDraftView, createMorningDraftController } from './morning-draft';
export const draftCopy = {
  ru: { remove: 'Удалить сохранённый личный черновик', confirm: 'Подтвердить удаление черновика', cancelDelete: 'Не удалять',
    warning: 'Удалится только сохранённый личный черновик. Готовое письмо не изменится. В этой версии нельзя восстановить или создать новый черновик для этого утра. Стирание резервных копий не обещается. Несохранённый ввод не станет опубликованным письмом.',
    deleted: 'Сохранённый черновик удалён. Новый черновик для этого утра создать нельзя. Текст в форме, если он остался, только несохранённый ввод.',
    limit: 'Достигнут предел безопасной памяти удалений. Содержимое скрыто; завершите сеанс и войдите снова для повторной проверки.',
    begin: 'Личный сохранённый черновик утра', title: 'Отдельный личный черновик',
    notice: 'Явное сохранение хранит текст на сервере, не со сквозным шифрованием. Доступен только вам при действующей паре. Это не подготовка письма: черновик не публикуется по сроку и не меняет готовое письмо. Удаление убирает текущий сохранённый черновик, но не гарантирует стирание резервных копий.',
    save: 'Сохранить личный черновик на сервере', cancel: 'Закрыть форму, сбросив несохранённый ввод', reload: 'Загрузить сохранённый личный черновик', retry: 'Повторить ту же операцию с черновиком',
    conflict: 'Серверная версия изменилась. Загрузите её; новый ввод в форме останется.',
    preserved: 'Несохранённый ввод оставлен в форме. Он ещё не сохранён на сервере.',
    pending: 'Результат неизвестен. Повтор использует ту же команду, не новое действие.', saved: 'Личный черновик сохранён на сервере. Письмо не подготовлено этим действием.',
    error: 'Не удалось выполнить действие. Ввод оставлен в форме.', cancelFirst: 'Сначала закройте текущую форму. Несохранённый ввод будет сброшен.' },
  en: { remove: 'Remove saved private draft', confirm: 'Confirm draft removal', cancelDelete: 'Do not remove',
    warning: 'Only the saved private draft is removed. The prepared letter is unchanged. This version cannot restore or create another draft for this morning. Backup erasure is not promised. Unsaved input does not become a published letter.',
    deleted: 'The saved draft was removed. Another draft cannot be created for this morning. Any text left in the form is unsaved input only.',
    limit: 'Safe deletion memory limit reached. Content is hidden; sign out and sign in again to recheck.',
    begin: 'Private saved morning draft', title: 'Separate private draft',
    notice: 'Explicit save stores text on the server, not end-to-end encrypted. Only you can access it while pair membership is active. This does not prepare a letter: the draft is not published at release and does not change a prepared letter. Removal clears the current saved draft, but does not promise backup erasure.',
    save: 'Save private draft on server', cancel: 'Close form and discard unsaved input', reload: 'Load saved private draft', retry: 'Retry the same draft operation',
    conflict: 'The server version changed. Load it; newer input stays in the form.',
    preserved: 'Unsaved input was kept in the form. It is not yet saved on the server.',
    pending: 'The outcome is unknown. Retry uses the same command, not a new action.', saved: 'Private draft saved on the server. This action did not prepare a letter.',
    error: 'The action did not complete. Input remains in the form.', cancelFirst: 'Close the current form first. Unsaved input will be discarded.' },
};
type Actions = ReturnType<typeof createMorningDraftController>['actions'];
export function MorningDraftPanel({ locale, selected, view, actions }: {
  locale: 'ru' | 'en'; selected: MorningSlot | null; view: MorningDraftView; actions: Actions;
}) {
  if (!view.available) return null;
  const t = draftCopy[locale], uncertain = view.status === 'unknown' || view.status === 'sending';
  return <View>
    {selected && typeof selected.prepared === 'boolean' && <Button title={t.begin}
      disabled={view.busy || uncertain || !!view.target} onPress={() => { void actions.begin(selected); }} />}
    {view.target && <View>
      <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
      <Text>{view.target.localDate} {view.target.localTime} · {view.target.timezone} {view.target.offset} · UTC {view.target.releaseAt}</Text>
      <TextInput accessibilityLabel={t.title} multiline maxLength={16000} value={view.draft} onChangeText={actions.setDraft} />
      <Button title={t.save} disabled={view.busy || uncertain || view.needsReload || view.state === 'deleted'} onPress={() => { void actions.save(); }} />
      <Button title={t.reload} disabled={view.busy || uncertain} onPress={() => { void actions.reload(); }} />
      {view.state === 'live' && <Button title={t.remove} disabled={view.busy || uncertain || view.needsReload} onPress={actions.beginDelete} />}
      {view.confirmation && <View><Text>{t.warning}</Text>
        <Button title={t.confirm} disabled={view.busy || uncertain} onPress={() => { void actions.confirmDelete(view.confirmation!.token); }} />
        <Button title={t.cancelDelete} onPress={actions.cancelDelete} /></View>}
      {view.state === 'deleted' && <Text>{t.deleted}</Text>}
      <Button title={t.cancel} disabled={uncertain} onPress={actions.cancel} />
      {view.status === 'conflict' && <Text>{t.conflict}</Text>}
      {view.status === 'saved' && <Text>{t.saved}</Text>}
      {view.draftPreserved && <Text>{t.preserved}</Text>}
      {view.status === 'unknown' && <View><Text>{t.pending}</Text><Button title={t.retry} disabled={view.busy} onPress={() => { void actions.retry(); }} /></View>}
      {view.error && <Text accessibilityRole="alert">{view.error === 'terminal_knowledge_limit' ? t.limit : view.error === 'cancel_edit_first' ? t.cancelFirst : t.error}</Text>}
    </View>}
  </View>;
}
