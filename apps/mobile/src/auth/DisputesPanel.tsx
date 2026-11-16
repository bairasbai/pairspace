import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { DisputesActions } from './disputes';
import { canReadDisputeMetadata, declineDisputeMetadata, joinDisputeMetadata, removeDisputeMetadata, resolveDisputeMetadata, type DisputeView } from './disputes-state';
import { disputesCopy } from './disputesCopy';
import { colors, radii, spacing, typography } from '../theme';
type Kind = 'create' | 'join' | 'decline' | 'resolve' | 'remove';
type Choice = { kind: Kind; id?: string; version?: number; winner?: string | null; generation: number; revision: number;
  controller: DisputesActions; actor: string | null; reader: DisputeView['reader'] };
function allowed(view: DisputeView, kind: Kind, id?: string, version?: number, winner?: string | null) {
  if (!view.available || !view.checkedAt || !view.userId || view.busy || view.pending || view.requiresRefresh) return false;
  if (kind === 'create') return view.checked && view.used < 100;
  const q = view.disputes.find(d => d.id === id && d.version === version);
  if (!q) return false;
  const scope = { coupleId: q.coupleId, membershipEpoch: q.membershipEpoch, userId: view.userId };
  if (kind === 'join' || kind === 'resolve') {
    const read = view.readerStatus === 'opened' && view.reader?.generation === view.generation
    && view.reader.dispute.id === id && view.reader.dispute.version === version
    && view.reader !== null;
    if (!read) return false;
    return kind === 'join' ? !!joinDisputeMetadata(q, scope, view.checkedAt, q.version, true)
      : !!resolveDisputeMetadata(q, scope, view.checkedAt, q.version, winner, true);
  }
  if (kind === 'decline') return !!declineDisputeMetadata(q, scope, view.checkedAt, q.version, true);
  if (kind === 'remove') return !!removeDisputeMetadata(q, scope, view.checkedAt, q.version, true);
  return false;
}
export function DisputesPanel({ controller, locale }: { controller: DisputesActions; locale: 'ru' | 'en' }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') controller.leaveScreen(); });
    return () => { subscription.remove(); controller.leaveScreen(); };
  }, [controller]);
  return view.available ? <Content key={view.generation} view={view} controller={controller} locale={locale}/> : null;
}
function Content({ view, controller, locale }: { view: DisputeView; controller: DisputesActions; locale: 'ru' | 'en' }) {
  const [choice, setChoice] = useState<Choice | null>(null), consumed = useRef<Choice | null>(null);
  const t = disputesCopy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
  const current = (c: Choice, v: DisputeView) => c.controller === controller && c.generation === v.generation && c.revision === v.revision
    && c.actor === v.userId && (!['join', 'resolve'].includes(c.kind) || c.reader === v.reader) && allowed(v, c.kind, c.id, c.version, c.winner);
  const begin = (kind: Kind, id?: string, version?: number, winner?: string | null) => setChoice({ kind, id, version, winner,
    generation: view.generation, revision: view.revision, actor: view.userId, reader: view.reader, controller });
  const confirm = () => {
    if (!choice || consumed.current === choice || !current(choice, controller.getSnapshot())) return;
    consumed.current = choice; setChoice(null);
    if (choice.kind === 'create') void controller.create(true);
    else if (choice.kind === 'join') void controller.join(choice.id!, true);
    else if (choice.kind === 'decline') void controller.decline(choice.id!, true);
    else if (choice.kind === 'resolve') void controller.resolve(choice.id!, choice.winner!, true);
    else void controller.remove(choice.id!, true);
  };
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action} style={styles.button}><Text style={styles.action}>{label}</Text></Pressable>;
  const reader = view.readerStatus === 'opened' && !blocked && view.reader?.generation === view.generation && view.userId
    && view.disputes.some(q => q.id === view.reader!.dispute.id && q.version === view.reader!.dispute.version)
    && canReadDisputeMetadata(view.reader.dispute, { coupleId: view.reader.dispute.coupleId, membershipEpoch: view.reader.dispute.membershipEpoch, userId: view.userId }, view.reader.checkedAt) ? view.reader : null;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={[typography.card, styles.text]}>{t.title}</Text>
      <Text style={styles.text}>{t.notice}</Text><Text style={styles.text}>{t.terms}</Text><Text style={styles.muted}>{t.capacity}</Text>
      {button(t.load, () => { void controller.refresh(); }, view.busy)}
      <Text style={styles.muted}>{view.checked ? t.checked : t.unchecked} {view.checkedAt}</Text>
      {view.checked && view.disputes.length === 0 && <Text style={styles.text}>{t.empty}</Text>}
      {view.disputes.map(q => <View key={q.id} style={styles.card}>
        <Text style={styles.text}>{q.contentState === 'removed' ? t.removed : t[q.decisionState]}</Text>
        <Text style={styles.text}>{q.judgeDate} · {q.timezone}</Text>
        {q.resolvedAt && <Text style={styles.text}>{q.winnerId === null ? t.draw : q.winnerId === q.authorId ? t.authorWins : t.recipientWins}</Text>}
        {q.contentState === 'active' && <>
          {button(t.read, () => { void controller.read(q.id); }, blocked || !view.checkedAt)}
          {q.recipientId === view.userId && q.decisionState === 'invited' && button(t.join, () => begin('join', q.id, q.version), !allowed(view, 'join', q.id, q.version))}
          {q.recipientId === view.userId && ['invited', 'joined'].includes(q.decisionState) && button(t.decline, () => begin('decline', q.id, q.version), !allowed(view, 'decline', q.id, q.version))}
          {q.decisionState === 'joined' && ([q.authorId, q.recipientId, null] as const).map((winner, index) => <View key={index}>
            {button(index === 0 ? t.authorWins : index === 1 ? t.recipientWins : t.draw, () => begin('resolve', q.id, q.version, winner), !allowed(view, 'resolve', q.id, q.version, winner))}
          </View>)}
          {q.authorId === view.userId && button(t.remove, () => begin('remove', q.id, q.version), !allowed(view, 'remove', q.id, q.version))}
        </>}
      </View>)}
      {view.readerStatus === 'loading' && <Text accessibilityLiveRegion="polite">{t.reading}</Text>}
      {reader && <View style={styles.card}><Text style={styles.muted}>{reader.dispute.judgeDate} · {reader.dispute.timezone}</Text><Text selectable style={styles.text}>{reader.claim}</Text>
        {reader.condition !== null && <Text selectable style={styles.text}>{reader.condition}</Text>}<Text style={styles.muted}>{t.disclosure}</Text></View>}
      {(view.reader || ['loading', 'error'].includes(view.readerStatus)) && button(t.close, controller.close)}
      {view.readerStatus === 'changed' && <Text>{t.readerChanged}</Text>}{view.readerStatus === 'error' && <Text>{t.readerError}</Text>}
      {([['claim', 'draftClaim', controller.setClaim, 8000], ['condition', 'draftCondition', controller.setCondition, 2000],
        ['judgeDate', 'judgeDate', controller.setJudgeDate, 10], ['timezone', 'timezone', controller.setTimezone, 100]] as const).map(([label, field, set, maxLength]) => <View key={label}>
          <Text style={styles.text}>{t[label]}</Text><TextInput accessibilityLabel={t[label]} value={view[field]} onChangeText={set} maxLength={maxLength}
            multiline={label === 'claim' || label === 'condition'} autoCapitalize="none" autoCorrect={false} style={styles.input}/>
        </View>)}
      <Text style={styles.muted}>{t.schedule}</Text>
      {button(t.create, () => begin('create'), !allowed(view, 'create'))}{button(t.clear, () => { controller.setClaim(''); controller.setCondition(''); })}
      {choice && current(choice, view) && <View style={styles.card}>
        <Text style={styles.text}>{choice.kind === 'create' ? t.confirmCreate : choice.kind === 'join' ? t.confirmJoin : choice.kind === 'decline' ? t.confirmDecline : choice.kind === 'resolve' ? t.confirmResolve : t.confirmRemove}</Text>
        {choice.kind === 'resolve' && <Text>{choice.winner === null ? t.draw : choice.winner === view.disputes.find(q => q.id === choice.id)?.authorId ? t.authorWins : t.recipientWins}</Text>}
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: blocked, busy: view.busy }} disabled={blocked} onPress={confirm} style={styles.button}><Text style={styles.action}>{t.confirm}</Text></Pressable>{button(t.cancel, () => setChoice(null))}
      </View>}
      {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && button(t.retry, () => { void controller.retry(); }, view.busy)}
      <Text accessibilityLiveRegion="polite" style={styles.text}>{view.status === 'retry' ? t.retryStatus : t[view.status]}</Text>
      {view.error && <Text>{t.error}</Text>}<Text style={styles.muted}>{t.ram}</Text>
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
