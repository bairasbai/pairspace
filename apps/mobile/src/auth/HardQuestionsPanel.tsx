import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { HardQuestionsActions } from './hard-questions';
import { canReadQuestion, type HardQuestion, type HardView } from './hard-questions-state';
import { hardQuestionsCopy } from './hardQuestionsCopy';
import { HardQuestionReader } from './HardQuestionReader';
type Choice = 'open' | 'decline' | 'remove';
function permitted(q: HardQuestion, kind: Choice, actor: string | null) {
  return q.contentState === 'active' && (kind === 'remove' ? q.authorId === actor : q.recipientId === actor && q.decisionState === 'sealed');
}
export function HardQuestionsPanel({ controller, locale }: { controller: HardQuestionsActions; locale: 'ru' | 'en' }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  // Navigation/unmount cancels display intent, while the sent command remains immutable.
  // The cleanup captures this controller only and cannot close a replacement instance.
  useEffect(() => () => controller.close(), [controller]);
  return view.available ? <HardContent key={view.generation} view={view} controller={controller} locale={locale}/> : null;
}
function HardContent({ view, controller, locale }: { view: HardView; controller: HardQuestionsActions; locale: 'ru' | 'en' }) {
  const [confirmation, setConfirmation] = useState<{ id: string; version: number; actor: string | null; kind: Choice } | null>(null);
  const t = hardQuestionsCopy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
  const canRead = !view.pending && !view.requiresRefresh && (!view.busy || view.readerStatus === 'loading');
  const confirming = confirmation && confirmation.actor === view.userId && view.questions.find(q => q.id === confirmation.id && q.version === confirmation.version && permitted(q, confirmation.kind, view.userId));
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled}
    onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  const begin = (q: HardQuestion, kind: Choice) => setConfirmation({ id: q.id, version: q.version, actor: view.userId, kind });
  const confirm = () => {
    if (!confirmation || !confirming) return;
    if (confirmation.kind === 'open') void controller.open(confirming.id, true);
    else if (confirmation.kind === 'decline') void controller.decline(confirming.id, true);
    else void controller.remove(confirming.id, true);
    setConfirmation(null);
  };
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text><Text>{t.visibility}</Text>
    {button(t.load, () => { void controller.load(); }, view.busy)}
    <Text>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text>{t.asOf} {view.checkedAt}</Text>}
    <Text>{t.capacity}</Text><Text>{t.remaining} {Math.max(0, view.capacity - view.used)}</Text>
    {view.checked && view.questions.length === 0 && <Text>{t.empty}</Text>}
    {view.questions.map((q, index) => <View key={q.id} style={{ gap: 4, paddingVertical: 8 }}>
      <Text>{t.author} {q.authorId === view.userId ? t.you : t.partner}</Text>
      <Text>{t.recipient} {q.recipientId === view.userId ? t.you : t.partner}</Text>
      <Text>{t.createdAt} {q.createdAt}</Text><Text>{t[q.decisionState]}</Text>
      {q.contentState === 'removed' && <Text>{t.removed}</Text>}
      {q.openedAt && <Text>{t.openedAt} {q.openedAt}</Text>}
      {canReadQuestion(q, view.userId!) && button(`${q.authorId === view.userId ? t.readOwn : t.readOpened} ${index + 1}`, () => { void controller.read(q.id); }, !canRead)}
      {permitted(q, 'open', view.userId) && button(`${t.open} ${index + 1}`, () => begin(q, 'open'), blocked)}
      {permitted(q, 'decline', view.userId) && button(`${t.decline} ${index + 1}`, () => begin(q, 'decline'), blocked)}
      {permitted(q, 'remove', view.userId) && button(`${t.remove} ${index + 1}`, () => begin(q, 'remove'), blocked)}
    </View>)}
    {confirming && confirmation && <View>
      <Text>{confirmation.kind === 'open' ? t.confirmOpen : confirmation.kind === 'decline' ? t.confirmDecline : t.confirmRemove}</Text>
      {button(t.confirm, confirm, blocked)}{button(t.cancel, () => setConfirmation(null))}
    </View>}
    {view.readerStatus === 'loading' && <Text accessibilityLiveRegion="polite">{t.reading}</Text>}
    {view.reader && <HardQuestionReader reader={view.reader} userId={view.userId} locale={locale}/>}
    {(view.reader || view.readerStatus === 'loading' || view.readerStatus === 'error') && button(t.close, controller.close)}
    {view.readerStatus === 'changed' && <Text accessibilityLiveRegion="polite">{t.readerChanged}</Text>}
    {view.readerStatus === 'error' && <Text accessibilityLiveRegion="polite">{t.readerError}</Text>}
    <Text>{t.closeNotice}</Text><Text>{t.limits}</Text>
    <TextInput accessibilityLabel={t.draftLabel} maxLength={8000} multiline value={view.draft} onChangeText={controller.setDraft} style={{ minHeight: 160, borderWidth: 1, padding: 8, textAlignVertical: 'top' }}/>
    <Text>{t.characters} {[...view.draft.normalize('NFC').replace(/\r\n?/g, '\n').trim()].length}/2000</Text>
    {button(t.seal, () => { void controller.seal(); }, blocked || !view.checked || view.used >= 100)}{button(t.cancelDraft, controller.cancelDraft)}
    {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && button(t.retry, () => { void controller.retry(); }, view.busy)}
    <Text accessibilityLiveRegion="polite">{view.status === 'retry' ? t.retryStatus : t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.ram}</Text>
  </ScrollView>;
}
