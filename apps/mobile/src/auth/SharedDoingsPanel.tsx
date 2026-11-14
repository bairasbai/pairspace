import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { SharedDoingsActions } from './shared-doings';
import { canAdvanceDoing, completeDoing, integer, mayChooseDoing, type DoingChoice, type DoingDraft,
  type DoingsView, type SharedDoing } from './shared-doings-state';
import { sharedDoingsCopy } from './sharedDoingsCopy';
type Locale = 'ru' | 'en';
type Choice = { kind: 'propose'; draft: DoingDraft } | { kind: DoingChoice; id: string; version: number; actor: string | null };
function Button({ label, action, disabled = false, busy = false }: { label: string; action: () => void; disabled?: boolean; busy?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy }} disabled={disabled} onPress={action}
    style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
}
export function SharedDoingsPanel({ controller, locale }: { controller: SharedDoingsActions; locale: Locale }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return view.available ? <Content key={view.generation} view={view} controller={controller} locale={locale}/> : null;
}
function Content({ view, controller, locale }: { view: DoingsView; controller: SharedDoingsActions; locale: Locale }) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const t = sharedDoingsCopy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
  const target = choice && choice.kind !== 'propose' ? view.doings.find(d => d.id === choice.id && d.version === choice.version) : null;
  const confirming = choice && (choice.kind === 'propose' ? choice.draft === view.draft && view.checked
    : target && choice.actor === view.userId && mayChooseDoing(target, view.userId, choice.kind));
  function confirm() {
    if (!choice || !confirming) return;
    if (choice.kind === 'propose') void controller.propose(true);
    else void controller[choice.kind](choice.id, true);
    setChoice(null);
  }
  const choose = (d: SharedDoing, kind: DoingChoice) => setChoice({ id: d.id, version: d.version, actor: view.userId, kind });
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text><Text>{t.visibility}</Text>
    <Button label={t.load} action={() => { void controller.load(); }} disabled={view.busy} busy={view.busy}/>
    <Text>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text>{t.asOf} {view.checkedAt}</Text>}
    <Text>{t.capacity}</Text><Text>{t.remaining} {Math.max(0, view.capacity - view.used)}</Text>
    {view.checked && view.doings.length === 0 && <Text>{t.empty}</Text>}
    {view.doings.map((doing, index) => <DoingRow key={`${view.generation}/${doing.id}/${doing.version}`} doing={doing} index={index + 1}
      actor={view.userId} controller={controller} locale={locale} choose={choose} blocked={blocked} busy={view.busy}/>)}
    <TextInput accessibilityLabel={t.titleInput} maxLength={800} value={view.draft.title} onChangeText={controller.setTitle} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>
    <Text>{t.kindInput}</Text>
    <View accessibilityRole="radiogroup">{(['book', 'series', 'course', 'other'] as const).map(kind => <Pressable key={kind} accessibilityRole="radio"
      accessibilityState={{ checked: view.draft.kind === kind }} onPress={() => controller.setKind(kind)} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{t[kind]}</Text></Pressable>)}</View>
    <TextInput accessibilityLabel={t.partsInput} maxLength={4} keyboardType="number-pad" value={view.draft.parts} onChangeText={controller.setParts} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>
    <Button label={t.propose} action={() => setChoice({ kind: 'propose', draft: view.draft })} disabled={blocked || !view.checked || view.used >= 100}/>
    <Button label={t.clear} action={controller.cancelDraft}/>
    {confirming && choice && <View>
      <Text>{choice.kind === 'propose' ? t.confirmPropose : choice.kind === 'join' ? t.confirmJoin : choice.kind === 'remove' ? t.confirmRemove
        : target?.decisionState === 'joined' ? t.confirmWithdraw : t.confirmDecline}</Text>
      <Button label={t.confirm} action={confirm} disabled={blocked}/><Button label={t.cancel} action={() => setChoice(null)}/>
    </View>}
    {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && <Button label={t.retry} action={() => { void controller.retry(); }} disabled={view.busy}/>}
    <Text accessibilityLiveRegion="polite">{view.status === 'retry' ? t.retryStatus : t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.ram}</Text>
  </ScrollView>;
}
function DoingRow({ doing: d, index, actor, controller, locale, choose, blocked, busy }: { doing: SharedDoing; index: number; actor: string | null;
  controller: SharedDoingsActions; locale: Locale; choose: (d: SharedDoing, kind: DoingChoice) => void; blocked: boolean; busy: boolean }) {
  const t = sharedDoingsCopy[locale];
  const at = d.contentState === 'active' ? actor === d.authorId ? d.authorAt : d.decisionState === 'joined' ? d.recipientAt : null : null;
  const [position, setPosition] = useState(at === null ? '' : String(at));
  if (d.contentState === 'removed') return <View><Text>{t.removed}</Text><Text>{t[d.decisionState]}</Text></View>;
  const number = Number(position), valid = /^[0-9]{1,4}$/.test(position) && integer(number, (at ?? 0) + 1, d.parts);
  return <View style={{ gap: 4, paddingVertical: 8 }}>
    <Text>{t.author} {d.authorId === actor ? t.you : t.partner}</Text><Text>{t.created} {d.createdAt}</Text>
    <Text>{d.title}</Text><Text>{t[d.kind]} · {t.total} {d.parts}</Text><Text>{t[d.decisionState]}</Text>
    <Text>{t.authorProgress} {d.authorAt}/{d.parts}</Text>
    <Text>{t.recipientProgress} {d.decisionState === 'joined' ? `${d.recipientAt}/${d.parts}` : t.absent}</Text>
    {completeDoing(d) && <Text>{t.complete}</Text>}
    {(['join', 'decline', 'remove'] as const).map(kind => mayChooseDoing(d, actor, kind) && <Button key={kind}
      label={`${kind === 'decline' && d.decisionState === 'joined' ? t.withdraw : t[kind]} ${index}`} action={() => choose(d, kind)} disabled={blocked} busy={busy}/>)}
    {canAdvanceDoing(d, actor ?? '') && <View>
      <Text>{t.forward}</Text><TextInput accessibilityLabel={`${t.progress} ${index}`} maxLength={4} keyboardType="number-pad" value={position}
        onChangeText={setPosition} style={{ minHeight: 48, borderWidth: 1, padding: 8 }}/>
      <Button label={`${t.advance} ${index}`} action={() => { void controller.advance(d.id, number, true); }} disabled={blocked || !valid} busy={busy}/>
    </View>}
  </View>;
}
