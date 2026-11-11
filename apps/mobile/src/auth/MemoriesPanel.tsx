import { Pressable, Text, TextInput, View } from 'react-native';
import { memoriesCopy } from './memoriesCopy';
import type { MemoriesView } from './memories';
export function MemoriesPanel({ locale, view, onDraft, onBody, onCreate, onRetry, onList, onLocalDate, onConsent, onCancel }: {
  locale: 'ru' | 'en'; view: MemoriesView; onDraft(text: string): void; onBody(text: string): void;
  onCreate(): void; onRetry(): void; onList(): void; onLocalDate(value: string): void; onConsent(value: boolean): void; onCancel(): void;
}) {
  if (!view.available) return null;
  const t = memoriesCopy[locale];
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action}
    style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text><Text>{t.limits}</Text>
    <TextInput accessibilityLabel={t.draft} value={view.draft} onChangeText={onDraft}
      maxLength={800} style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel={t.body} value={view.body} onChangeText={onBody} multiline
      maxLength={8000} style={{ minHeight: 96, borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel={t.localDate} value={view.localDate} onChangeText={onLocalDate}
      maxLength={10} autoCorrect={false} placeholder="YYYY-MM-DD" style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    <Pressable accessibilityRole="checkbox" accessibilityLabel={t.consent} accessibilityState={{ checked: view.consent }}
      onPress={() => onConsent(!view.consent)} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{view.consent ? '☑ ' : '☐ '}{t.consent}</Text></Pressable>
    {button(t.create, onCreate, view.busy || view.requiresRefresh || view.pending !== null || !view.consent)}
    {button(t.cancel, onCancel, false)}<Text>{t.cancelHint}</Text>
    {view.pending && <Text selectable>{t.pending} {view.pending.title} · {view.pending.localDate}{'\n'}{view.pending.body}</Text>}
    {view.status === 'retry' && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.list, onList, view.busy)}{view.error && <Text>{t.error}</Text>}
    <Text>{t.bound}</Text>{view.checked && view.memories.length === 0 && <Text>{t.none}</Text>}
    {view.memories.map(memory => <View key={memory.id} style={{ paddingVertical: 8 }}>
      <Text selectable>{memory.title}</Text><Text selectable>{memory.body}</Text>
      <Text>{t.event} {memory.localDate}</Text><Text>{t.recorded} {memory.createdAt}</Text>
      <Text>{t.author} {memory.creatorId}</Text>
    </View>)}
  </View>;
}
