import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { DailyQuestionsActions } from './daily-questions';
import { canReadDailyMetadata, type DailyView } from './daily-questions-state';
import { dailyQuestionsCopy } from './dailyQuestionsCopy';
import { colors, radii, spacing, typography } from '../theme';
type Kind = 'create' | 'rewrite' | 'remove';
type Choice = { kind: Kind; id?: string; version?: number; generation: number; revision: number; today: DailyView['today'];
 controller: DailyQuestionsActions; actor: string | null; reader: DailyView['reader'] };
function target(view: DailyView, id?: string) {
 for (const entry of view.slots) { const answer = entry.answers.find(answer => answer.id === id); if (answer) return { slot: entry.slot, answer }; }
 return null;
}
function permitted(view: DailyView, kind: Kind, id?: string, version?: number) {
 if (!view.available || !view.checkedAt || !view.userId || !view.today || view.busy || view.pending || view.requiresRefresh) return false;
 if (kind === 'create') return view.checked && !view.slots.some(entry => entry.slot.day === view.today!.day && entry.answers.some(a => a.authorId === view.userId));
 const selected = target(view, id);
 if (!selected || selected.answer.version !== version || selected.answer.authorId !== view.userId || selected.answer.contentState !== 'active') return false;
 if (kind === 'remove') return true;
 return selected.slot.day === view.today.day && view.readerStatus === 'opened' && view.reader?.generation === view.generation
  && view.reader.answer.id === id && view.reader.answer.version === version;
}
export function DailyQuestionsPanel({ controller, locale }: { controller: DailyQuestionsActions; locale: 'ru' | 'en' }) {
 const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
 useEffect(() => {
  const subscription = AppState.addEventListener('change', state => { if (state !== 'active') controller.leaveScreen(); });
  return () => { subscription.remove(); controller.leaveScreen(); };
 }, [controller]);
 return view.available ? <Content key={view.generation} controller={controller} view={view} locale={locale}/> : null;
}
function Content({ controller, view, locale }: { controller: DailyQuestionsActions; view: DailyView; locale: 'ru' | 'en' }) {
 const [choice, setChoice] = useState<Choice | null>(null), consumed = useRef<Choice | null>(null);
 const t = dailyQuestionsCopy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
 const current = (c: Choice, v: DailyView) => c.controller === controller && c.generation === v.generation && c.revision === v.revision
  && c.actor === v.userId && c.today === v.today && (c.kind !== 'rewrite' || c.reader === v.reader) && permitted(v, c.kind, c.id, c.version);
 const begin = (kind: Kind, id?: string, version?: number) => setChoice({ kind, id, version, generation: view.generation, revision: view.revision,
  today: view.today, controller, actor: view.userId, reader: view.reader });
 const confirm = () => {
  if (!choice || consumed.current === choice || !current(choice, controller.getSnapshot())) return;
  consumed.current = choice; setChoice(null);
  if (choice.kind === 'create') void controller.create(true);
  else if (choice.kind === 'rewrite') void controller.rewrite(choice.id!, true);
  else void controller.remove(choice.id!, true);
 };
 const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }}
  disabled={disabled} onPress={action} style={styles.button}><Text style={styles.action}>{label}</Text></Pressable>;
 const latest = view.reader ? target(view, view.reader.answer.id) : null;
 const reader = view.readerStatus === 'opened' && !blocked && view.reader?.generation === view.generation && latest
  && latest.answer.version === view.reader.answer.version && latest.answer.contentState === 'active' ? view.reader : null;
 const confirmationSlot = choice?.id ? target(view, choice.id)?.slot : view.today;
 return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
 <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
  <Text accessibilityRole="header" style={[typography.card, styles.text]}>{t.title}</Text><Text style={styles.text}>{t.notice}</Text>
  <Text style={styles.text}>{t.disclosure}</Text><Text style={styles.muted}>{t.calendar}</Text>
  {button(t.refresh, () => { void controller.refresh(); }, view.busy)}
  <Text style={styles.muted}>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text style={styles.muted}>{t.asOf} {view.checkedAt}</Text>}
  {view.today && <View style={styles.card}><Text style={styles.text}>{t.today} {view.today.day}</Text><Text style={styles.muted}>{t.zone} {view.today.timezone}</Text>
    <Text accessibilityRole="header" style={styles.text}>{locale === 'ru' ? view.today.promptRU : view.today.promptEN}</Text></View>}
  <Text style={styles.muted}>{t.historyNotice}</Text>{view.checked && view.slots.length === 0 && <Text style={styles.text}>{t.noDays}</Text>}
  {view.slots.map(entry => <View key={entry.slot.id} style={styles.card}>
    <Text accessibilityRole="header" style={styles.text}>{entry.slot.day}</Text><Text style={styles.muted}>{entry.slot.timezone}</Text>
    <Text style={styles.text}>{locale === 'ru' ? entry.slot.promptRU : entry.slot.promptEN}</Text>
    {entry.answers.map(answer => <View key={answer.id} style={{ gap: spacing.xs }}>
      <Text style={styles.text}>{answer.authorId === view.userId ? t.own : t.partner}</Text><Text style={styles.muted}>{answer.contentState === 'removed' ? t.removed : t.active}</Text>
      {answer.contentState === 'active' && <>
        {button(`${t.read} · ${entry.slot.day} · ${answer.authorId === view.userId ? t.own : t.partner}`, () => { void controller.read(answer.id); }, blocked || !canReadDailyMetadata(entry, answer, view.userId, view.checkedAt))}
        {answer.authorId === view.userId && <>
          {entry.slot.day === view.today?.day && button(t.edit, () => begin('rewrite', answer.id, answer.version), !permitted(view, 'rewrite', answer.id, answer.version))}
          {button(`${t.remove} · ${entry.slot.day}`, () => begin('remove', answer.id, answer.version), !permitted(view, 'remove', answer.id, answer.version))}
        </>}
      </>}
    </View>)}
  </View>)}
  {view.nextBeforeDay && button(t.loadMore, () => { void controller.loadMore(); }, view.busy || view.pending || view.requiresRefresh)}
  {view.readerStatus === 'loading' && <Text accessibilityLiveRegion="polite" style={styles.muted}>{t.reading}</Text>}
  {reader && <View style={styles.card}><Text accessibilityRole="header" style={styles.text}>{t.readerTitle}</Text><Text style={styles.muted}>{reader.slot.day} · {reader.slot.timezone}</Text>
    <Text selectable style={styles.text}>{reader.text}</Text></View>}
  {(view.reader || view.readerStatus === 'loading' || view.readerStatus === 'error') && button(t.close, controller.close)}
  {view.readerStatus === 'changed' && <Text accessibilityLiveRegion="polite" style={styles.muted}>{t.readerChanged}</Text>}
  {view.readerStatus === 'error' && <Text accessibilityLiveRegion="polite" style={styles.muted}>{t.readerError}</Text>}
  {!reader && <Text style={styles.muted}>{t.locked}</Text>}<Text style={styles.muted}>{t.editNotice}</Text>
  <Text style={styles.text}>{t.draftLabel}</Text><TextInput accessibilityLabel={t.draftLabel} multiline maxLength={8000} value={view.draft} onChangeText={controller.setDraft} style={styles.input}/>
  <Text style={styles.muted}>{t.characters} {[...view.draft.normalize('NFC').replace(/\r\n?/g, '\n').trim()].length}/2000</Text>
  {button(t.submit, () => begin('create'), !permitted(view, 'create'))}{button(t.clear, controller.cancelDraft)}{button(t.skip, controller.cancelDraft)}
  {choice && current(choice, view) && <View style={styles.card}>
    <Text style={styles.text}>{choice.kind === 'create' ? t.confirmCreate : choice.kind === 'rewrite' ? t.confirmRewrite : t.confirmRemove}</Text>
    {confirmationSlot && <><Text style={styles.muted}>{confirmationSlot.day} · {confirmationSlot.timezone}</Text><Text style={styles.text}>{locale === 'ru' ? confirmationSlot.promptRU : confirmationSlot.promptEN}</Text></>}
    {choice.kind !== 'remove' && <Text style={styles.text}>{t.disclosure}</Text>}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: blocked, busy: view.busy }} disabled={blocked} onPress={confirm} style={styles.button}><Text style={styles.action}>{t.confirm}</Text></Pressable>
    {button(t.cancel, () => setChoice(null))}
  </View>}
  {view.pending && <Text style={styles.muted}>{t.pending}</Text>}{view.status === 'retry' && button(t.retry, () => { void controller.retry(); }, view.busy)}
  <Text accessibilityLiveRegion="polite" style={styles.text}>{view.status === 'retry' ? t.retryStatus : t[view.status]}</Text>{view.error && <Text style={styles.text}>{t.error}</Text>}
  <Text style={styles.muted}>{t.ram}</Text>
 </ScrollView></KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
 root: { flex: 1, backgroundColor: colors.background }, content: { padding: spacing.md, gap: spacing.sm },
 text: { color: colors.ink }, muted: { color: colors.muted }, action: { color: colors.accent, fontWeight: '600' },
 button: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.sm },
 card: { backgroundColor: colors.surface, borderRadius: radii.card, padding: spacing.md, gap: spacing.sm },
 input: { color: colors.ink, backgroundColor: colors.surface, minHeight: 160, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.border, borderRadius: radii.control, padding: spacing.sm },
});
