import { MorningDiscussionMutationsPanel, mutationCopy } from './MorningDiscussionMutationsPanel';
import { Button, Text, TextInput, View } from 'react-native';
import type { MorningSlot } from './morning-model';
import type { MorningDiscussionView, createMorningDiscussionsController } from './morning-discussions';
export const discussionCopy = {
  ru: { open: 'Обсудить утреннее письмо', title: 'Обсуждение этого утра',
    notice: 'Ответы относятся только к этому утреннему письму. Свои ответы можно изменить или удалить для обоих. Уведомлений и копирования в другие письма нет.',
    first: 'Первые ответы', last: 'Последние ответы', older: 'Предыдущие ответы', newer: 'Следующие ответы', refresh: 'Обновить обсуждение',
    body: 'Ответ на утреннее письмо', send: 'Отправить ответ', clear: 'Очистить черновик ответа', close: 'Закрыть обсуждение',
    own: 'Вы', partner: 'Партнёр', empty: 'В этом окне пока нет ответов.',
    sent: 'Отправлено. Обновите обсуждение, чтобы увидеть ответ',
    saved: 'Черновики обсуждений в памяти', pending: 'Результат отправки пока не подтверждён для утра', retry: 'Повторить ту же отправку',
    error: 'Действие не выполнено. Черновик сохранён.', limit: 'В памяти уже 30 черновиков обсуждений. Откройте и очистите один явно; остальные сохранены.' },
  en: { open: 'Discuss this morning letter', title: 'Discussion for this morning',
    notice: 'Replies belong only to this morning letter. You can edit or delete your own replies for both. No notifications or copying into other letters.',
    first: 'First replies', last: 'Latest replies', older: 'Previous replies', newer: 'Next replies', refresh: 'Refresh discussion',
    body: 'Reply to morning letter', send: 'Send reply', clear: 'Clear reply draft', close: 'Close discussion',
    own: 'You', partner: 'Partner', empty: 'No replies in this window yet.',
    sent: 'Sent. Refresh the discussion to see your reply',
    saved: 'Discussion drafts in memory', pending: 'Sending is not confirmed yet for the morning', retry: 'Retry the same send',
    error: 'The action did not complete. Your draft is preserved.', limit: 'There are already 30 discussion drafts in memory. Open and clear one explicitly; the others are preserved.' },
};
type Actions = ReturnType<typeof createMorningDiscussionsController>['actions'];
type Props = { locale: 'ru' | 'en'; view: MorningDiscussionView; actions: Actions;
  openedSlot: MorningSlot | null; onOpenSaved: (slot: MorningSlot) => void };
const label = (slot: MorningSlot) => `${slot.localDate} ${slot.localTime} · ${slot.timezone} ${slot.offset}`;
export function MorningDiscussionsPanel({ locale, view, actions, openedSlot, onOpenSaved }: Props) {
  if (!view.available) return null;
  const t = discussionCopy[locale];
  const eligible = openedSlot?.state === 'available' && (openedSlot.senderId === view.userId
    ? openedSlot.prepared === true : openedSlot.recipientId === view.userId && !!openedSlot.openedAt);
  const visible = eligible && openedSlot.id === view.slot?.id;
  return <View>
    {eligible && <Button title={t.open} disabled={view.busy} onPress={() => { void actions.open(openedSlot); }} />}
    {!!view.savedDraftSlots.length && <Text>{t.saved}</Text>}
    {view.savedDraftSlots.map(slot => <Button key={slot.id} title={`${t.saved}: ${label(slot)}`} onPress={() => onOpenSaved(slot)} />)}
    {view.pendingId && <View><Text>{t.pending}{view.pendingSlot ? `: ${label(view.pendingSlot)}` : ''}</Text>
      <Button title={t.retry} disabled={view.busy} onPress={() => { void actions.retry(); }} /></View>}
    {view.error && <Text accessibilityRole="alert">{view.error === 'draft_limit' ? t.limit : t.error}</Text>}
    <MorningDiscussionMutationsPanel locale={locale} editor={view.editor} deletion={view.deletion}
      slotId={visible ? openedSlot.id : undefined}
      targetVisible={!!visible && view.messages.some(message => message.id === view.editor.targetId && message.slotId === openedSlot.id)}
      busy={view.busy} suspended={view.suspended} actions={actions} />
    {visible && <View><Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
      <Text>{label(openedSlot)}</Text>
      {view.status === 'sent' && <Text>{t.sent}</Text>}
      <Button title={t.refresh} disabled={view.busy} onPress={() => { void actions.first(); }} />
      <Button title={t.first} disabled={view.busy} onPress={() => { void actions.first(); }} />
      <Button title={t.last} disabled={view.busy} onPress={() => { void actions.last(); }} />
      <Button title={t.older} disabled={view.busy || !view.history?.hasPrevious} onPress={() => { void actions.older(); }} />
      <Button title={t.newer} disabled={view.busy || !view.history?.hasNext} onPress={() => { void actions.newer(); }} />
      {view.history && !view.messages.length && <Text>{t.empty}</Text>}
      {view.messages.map(message => <View key={message.id}>
        <Text>{message.authorId === view.userId ? t.own : t.partner} · {message.createdAt}</Text>
        {message.deletedAt ? <Text>{mutationCopy[locale].tombstone}</Text> : <View>
          <Text selectable>{message.body}</Text>
          {message.version > 1 && <Text>{mutationCopy[locale].edited}</Text>}
          {message.authorId === view.userId && <View>
            <Button title={mutationCopy[locale].edit} disabled={view.busy || !!view.suspended} onPress={() => actions.beginEdit(message.id)} />
            <Button title={mutationCopy[locale].remove} disabled={view.busy || !!view.suspended} onPress={() => actions.beginDelete(message.id)} />
          </View>}
        </View>}
      </View>)}
      <TextInput multiline accessibilityLabel={t.body} value={view.draft} maxLength={16000} onChangeText={actions.setDraft} />
      <Button title={t.send} disabled={view.busy || !!view.pendingId || !!view.suspended} onPress={() => { void actions.send(); }} />
      <Button title={t.clear} onPress={actions.clearDraft} /><Button title={t.close} onPress={actions.close} />
    </View>}
  </View>;
}
