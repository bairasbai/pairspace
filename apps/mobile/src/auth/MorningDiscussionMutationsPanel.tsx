import { Button, Text, TextInput, View } from 'react-native';
import type { DiscussionEditor, DiscussionDelete, createMorningDiscussionMutations } from './morning-discussion-mutations';
export const mutationCopy = {
  ru: { edit: 'Изменить свой ответ', remove: 'Удалить свой ответ для обоих', edited: 'Изменено', tombstone: 'Ответ удалён',
    body: 'Личный черновик изменения ответа', save: 'Сохранить изменение', cancel: 'Отменить редактирование', reload: 'Загрузить текущую версию ответа',
    retryEdit: 'Повторить то же изменение', retryDelete: 'Повторить то же удаление',
    other: 'Открыт личный черновик изменения другого утра. Вернитесь к нему или явно отмените редактирование.',
    reviewDraft: 'Ваш изменённый черновик сохранён. Проверьте его перед сохранением поверх загруженной версии.',
    conflict: 'Ответ изменился. Черновик сохранён. Загрузите текущую версию перед сохранением.',
    cancelFirst: 'Сначала явно отмените редактирование другого ответа. Его черновик сохранён.',
    deletedDraft: 'Ответ удалён. Оставшийся личный черновик не отправлен и не может восстановить ответ.',
    confirm: 'Удалить ответ безвозвратно для обоих', cancelDelete: 'Отменить удаление',
    warning: 'Удаляется только этот ответ, не исходное утреннее письмо. Восстановить текст нельзя. Ответы партнёра остаются; партнёру потребуется обновить обсуждение.',
    pending: 'Результат попытки пока неизвестен. Повтор использует ту же команду.', saved: 'Изменение сохранено.',
    error: 'Действие не выполнено. Личный черновик сохранён.',
    suspended: 'Достигнут предел защитной памяти этой сессии. Новые действия остановлены. Для продолжения войдите заново; сначала скопируйте нужные личные черновики.' },
  en: { edit: 'Edit my reply', remove: 'Delete my reply for both', edited: 'Edited', tombstone: 'Reply deleted',
    body: 'Private reply edit draft', save: 'Save edit', cancel: 'Cancel editing', reload: 'Load current reply version',
    retryEdit: 'Retry the same edit', retryDelete: 'Retry the same deletion',
    other: 'A private edit draft belongs to another morning. Return to it or explicitly cancel editing.',
    reviewDraft: 'Your edited draft was preserved. Review it before saving over the loaded version.',
    conflict: 'The reply changed. Your draft is preserved. Load the current version before saving.',
    cancelFirst: 'Explicitly cancel editing the other reply first. Its draft is preserved.',
    deletedDraft: 'This reply was deleted. The remaining private draft was not sent and cannot restore it.',
    confirm: 'Permanently delete reply for both', cancelDelete: 'Cancel deletion',
    warning: 'Only this reply is deleted, not the original morning letter. Its text cannot be restored. Partner replies remain; your partner must refresh the discussion.',
    pending: 'The attempt is not confirmed. Retry uses the same command.', saved: 'Edit saved.',
    error: 'The action did not complete. Your private draft is preserved.',
    suspended: 'This session reached its protective memory limit. New actions are stopped. Sign in again to continue; first copy any private drafts you need.' },
};
type Actions = ReturnType<typeof createMorningDiscussionMutations>['actions'];
export function MorningDiscussionMutationsPanel({ locale, editor, deletion, slotId, targetVisible, busy, suspended, actions }: {
  locale: 'ru' | 'en'; editor: DiscussionEditor; deletion: DiscussionDelete; slotId?: string; targetVisible: boolean;
  busy: boolean; suspended?: boolean; actions: Actions;
}) {
  const t = mutationCopy[locale];
  const editingHere = !!editor.targetId && editor.slotId === slotId && targetVisible;
  const uncertain = editor.status === 'unknown' || editor.status === 'sending';
  const locked = busy || !!suspended || uncertain;
  return <View>
    {suspended && <Text accessibilityRole="alert">{t.suspended}</Text>}
    {editor.targetId && <View>
      {!editingHere && <Text>{t.other}</Text>}
      {editingHere && <View>
        {editor.status === 'deleted' && <Text>{t.deletedDraft}</Text>}
        {editor.status === 'saved' && <Text>{t.saved}</Text>}
        {editor.draftPreserved && <Text>{t.reviewDraft}</Text>}
        <TextInput accessibilityLabel={t.body} multiline maxLength={16000} value={editor.draft} onChangeText={actions.setEditDraft} />
        <Button title={t.save} disabled={locked || editor.needsReload || editor.status === 'deleted'} onPress={() => { void actions.saveEdit(); }} />
        <Button title={t.reload} disabled={locked || editor.status === 'deleted'} onPress={() => { void actions.reloadEdit(); }} />
      </View>}
      {(editor.status === 'conflict' || editor.needsReload && editor.status !== 'deleted') && <Text>{t.conflict}</Text>}
      {editor.error && <Text accessibilityRole="alert">{editor.error === 'cancel_edit_first' ? t.cancelFirst : t.error}</Text>}
      {editor.status === 'unknown' && <View><Text>{t.pending}</Text><Button title={t.retryEdit} disabled={busy || !!suspended} onPress={() => { void actions.retryEdit(); }} /></View>}
      <Button title={t.cancel} disabled={busy || uncertain} onPress={actions.cancelEdit} />
    </View>}
    {deletion.confirmation && deletion.confirmation.slotId === slotId && <View>
      <Text>{t.warning}</Text><Text>#{deletion.confirmation.seq} · {deletion.confirmation.createdAt}</Text>
      <Button title={t.confirm} disabled={busy || !!suspended} onPress={() => { void actions.confirmDelete(deletion.confirmation!.token); }} />
      <Button title={t.cancelDelete} onPress={actions.cancelDelete} />
    </View>}
    {deletion.status === 'unknown' && <View><Text>{t.pending}</Text><Button title={t.retryDelete} disabled={busy || !!suspended} onPress={() => { void actions.retryDelete(); }} /></View>}
    {deletion.status === 'deleted' && <Text>{t.tombstone}</Text>}
    {deletion.error && <Text accessibilityRole="alert">{t.error}</Text>}
  </View>;
}
