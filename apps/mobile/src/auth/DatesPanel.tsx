import { Pressable, Text, TextInput, View } from 'react-native';
import { datesCopy } from './datesCopy';
import type { DatesView } from './dates';
export function DatesPanel({ locale, view, onDraft, onCreate, onRetry, onList, onLocalDate, onTimezone, onCancel }: {
  locale: 'ru' | 'en'; view: DatesView; onDraft(text: string): void; onCreate(): void;
  onRetry(): void; onList(): void; onLocalDate(value: string): void; onTimezone(value: string): void; onCancel(): void;
}) {
  if (!view.available) return null;
  const t = datesCopy[locale];
  const blocked = view.busy || view.requiresRefresh || view.pending !== null;
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action}
    style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    <TextInput accessibilityLabel={t.draft} value={view.draft} onChangeText={onDraft}
      maxLength={800} autoCorrect={false} style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel={t.localDate} value={view.localDate} onChangeText={onLocalDate}
      maxLength={10} autoCorrect={false} placeholder="YYYY-MM-DD" style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel={t.timezone} value={view.timezone} onChangeText={onTimezone}
      maxLength={100} autoCorrect={false} autoCapitalize="none" placeholder="Asia/Tokyo"
      style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    {button(t.create, onCreate, blocked)}
    {button(t.cancel, onCancel, false)}<Text>{t.cancelHint}</Text>
    {view.pending && <Text>{t.pending} {view.pending.title} · {view.pending.localDate} · {view.pending.timezone}</Text>}
    {view.status === 'retry' && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.list, onList, view.busy)}
    {view.error && <Text>{t.error}</Text>}
    <Text>{t.bound}</Text>
    {view.checked && view.dates.length === 0 && <Text>{t.none}</Text>}
    {view.dates.map(date => <View key={date.id} style={{ paddingVertical: 8 }}>
      <Text selectable>{date.title}</Text><Text selectable>{date.localDate} · {date.timezone}</Text>
    </View>)}
  </View>;
}
