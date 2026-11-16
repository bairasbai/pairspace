import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CapsulesActions } from './capsules';
import type { CapsuleView } from './capsules-state';
import { CapsuleReader } from './CapsuleReader';
import { capsulesCopy } from './capsulesCopy';
import { colors, radii, spacing, typography } from '../theme';

type Kind = 'create' | 'reseal' | 'remove';
type Choice = { kind: Kind; id?: string; version?: number; generation: number; revision: number; controller: CapsulesActions; actor: string | null };
function allowed(view: CapsuleView, kind: Kind, id?: string, version?: number) {
  if (!view.available || !view.checked || !view.checkedAt || view.busy || view.pending || view.requiresRefresh) return false;
  if (kind === 'create') return view.used === 0;
  const capsule = view.capsules.find(c => c.id === id && c.version === version && c.authorId === view.userId && c.contentState === 'active');
  return !!capsule && (kind === 'remove' || view.checkedAt < capsule.releaseAt);
}
export function CapsulesPanel({ controller, locale }: { controller: CapsulesActions; locale: 'ru' | 'en' }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') controller.leaveScreen(); });
    return () => { subscription.remove(); controller.leaveScreen(); };
  }, [controller]);
  return view.available ? <Content key={view.generation} view={view} controller={controller} locale={locale}/> : null;
}
function Content({ view, controller, locale }: { view: CapsuleView; controller: CapsulesActions; locale: 'ru' | 'en' }) {
  const [choice, setChoice] = useState<Choice | null>(null), consumed = useRef<Choice | null>(null);
  const t = capsulesCopy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
  const isCurrent = (selection: Choice, current: CapsuleView) => selection.controller === controller && selection.generation === current.generation
    && selection.revision === current.revision && selection.actor === current.userId && allowed(current, selection.kind, selection.id, selection.version);
  const confirming = choice && isCurrent(choice, view);
  const begin = (kind: Kind, id?: string, version?: number) => setChoice({ kind, id, version, generation: view.generation, revision: view.revision, controller, actor: view.userId });
  const confirm = () => {
    if (!choice || consumed.current === choice || !isCurrent(choice, controller.getSnapshot())) return;
    consumed.current = choice; setChoice(null);
    if (choice.kind === 'create') void controller.create(true);
    else if (choice.kind === 'reseal') void controller.reseal(choice.id!, true);
    else void controller.remove(choice.id!, true);
  };
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }}
    disabled={disabled} onPress={action} style={[styles.button, disabled && { opacity: 0.55 }]}><Text style={styles.action}>{label}</Text></Pressable>;
  const visible = view.capsules.filter(c => c.authorId === view.userId);
  const reader = view.readerStatus === 'opened' && !blocked && view.reader && visible.some(c => c.id === view.reader!.capsule.id && c.version === view.reader!.capsule.version && c.contentState === 'active') ? view.reader : null;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={[typography.card, styles.text]}>{t.title}</Text>
      <Text style={styles.text}>{t.notice}</Text><Text style={styles.text}>{t.visibility}</Text><Text style={styles.muted}>{t.capacity}</Text>
      {button(t.load, () => { void controller.load(); }, view.busy)}
      <Text style={styles.muted}>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text style={styles.muted}>{t.asOf} {view.checkedAt}</Text>}
      {view.checked && visible.length === 0 && <Text style={styles.text}>{t.empty}</Text>}
      {visible.map(c => <View key={c.id} style={styles.card}>
        <Text style={styles.text}>{c.contentState === 'removed' ? t.removed : view.checkedAt && view.checkedAt >= c.releaseAt ? t.ready : t.sealed}</Text>
        <Text style={styles.text}>{t.release} {c.localDate} {c.localTime} {c.timezone} {c.offset}</Text><Text style={styles.muted}>{t.utc} {c.releaseAt}</Text>
        {c.contentState === 'active' && <>
          {view.checkedAt && view.checkedAt >= c.releaseAt
            ? button(t.read, () => { void controller.read(c.id); }, blocked || !view.checked)
            : <Text style={styles.muted}>{t.waiting}</Text>}
          {view.checkedAt && view.checkedAt < c.releaseAt && button(t.reseal, () => begin('reseal', c.id, c.version), blocked || !view.checked)}
          {button(t.remove, () => begin('remove', c.id, c.version), blocked || !view.checked)}
        </>}
      </View>)}
      {view.readerStatus === 'loading' && <Text accessibilityLiveRegion="polite" style={styles.muted}>{t.reading}</Text>}
      {reader && <CapsuleReader reader={reader} userId={view.userId} locale={locale}/>}
      {(view.reader || ['loading', 'error'].includes(view.readerStatus)) && button(t.close, controller.close)}
      {view.readerStatus === 'changed' && <Text accessibilityLiveRegion="polite" style={styles.muted}>{t.readerChanged}</Text>}
      {view.readerStatus === 'error' && <Text accessibilityLiveRegion="polite" style={styles.muted}>{t.readerError}</Text>}
      <Text style={styles.text}>{t.draftLabel}</Text>
      <TextInput accessibilityLabel={t.draftLabel} maxLength={8000} multiline value={view.draft} onChangeText={controller.setDraft}
        style={[styles.input, { minHeight: 160, textAlignVertical: 'top' }]}/>
      <Text style={styles.muted}>{t.characters} {[...view.draft.normalize('NFC').replace(/\r\n?/g, '\n').trim()].length}/2000</Text>
      <Text style={styles.muted}>{t.scheduleNotice}</Text>
      {(['localDate', 'localTime', 'timezone', 'offset'] as const).map(field => <View key={field} style={{ gap: spacing.xs }}>
        <Text style={styles.text}>{t[field]}</Text><TextInput accessibilityLabel={t[field]} value={view.schedule[field]} onChangeText={value => controller.setSchedule(field, value)}
          autoCapitalize="none" autoCorrect={false} maxLength={field === 'timezone' ? 100 : 10} style={styles.input}/>
      </View>)}
      {button(t.suggest, controller.suggestYear, blocked || !view.checked)}
      {button(t.seal, () => begin('create'), !allowed(view, 'create'))}{button(t.cancelDraft, controller.cancelDraft)}
      {confirming && choice && <View style={styles.card}><Text style={styles.text}>{choice.kind === 'create' ? t.confirmCreate : choice.kind === 'reseal' ? t.confirmReseal : t.confirmRemove}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: blocked, busy: view.busy }} disabled={blocked} onPress={confirm} style={styles.button}><Text style={styles.action}>{t.confirm}</Text></Pressable>{button(t.cancel, () => setChoice(null))}</View>}
      {view.pending && <Text style={styles.muted}>{t.pending}</Text>}
      {view.status === 'retry' && button(t.retry, () => { void controller.retry(); }, view.busy)}
      <Text accessibilityLiveRegion="polite" style={styles.text}>{view.status === 'retry' ? t.retryStatus : t[view.status]}</Text>
      {view.error && <Text style={styles.text}>{t.error}</Text>}<Text style={styles.muted}>{t.ram}</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, content: { padding: spacing.md, gap: spacing.sm },
  text: { color: colors.ink }, muted: { color: colors.muted }, action: { color: colors.accent, fontWeight: '600' },
  button: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.card, padding: spacing.md, gap: spacing.sm },
  input: { color: colors.ink, backgroundColor: colors.surface, minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radii.control, padding: spacing.sm },
});
