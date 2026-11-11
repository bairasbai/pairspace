import { Pressable, Text, TextInput, View } from 'react-native';
import type { Recurrence, LeapDayPolicy } from '../../../../packages/domain/dates/recurrence';
import { datesCopy } from './datesCopy';
import type { DatesView } from './dates';
export function DatesPanel({ locale, view, onDraft, onCreate, onRetry, onList, onLocalDate, onTimezone, onCancel, onRecurrence, onLeapDayPolicy, onEdit }: {
  onEdit(id: string): void;
  onRecurrence(value: Recurrence): void; onLeapDayPolicy(value: LeapDayPolicy): void;
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
    <Text>{t.recurrence}</Text>
    {(['once', 'annual'] as const).map(value => <Pressable key={value} accessibilityRole="radio"
      accessibilityState={{ checked: view.recurrence === value }} onPress={() => onRecurrence(value)}
      style={{ minHeight: 48, justifyContent: 'center' }}><Text>{t[value]}</Text></Pressable>)}
    {view.recurrence === 'annual' && view.localDate.endsWith('-02-29') && <View>
      <Text>{t.leapChoice}</Text>
      {(['leap_years_only', 'feb28', 'mar1'] as const).map(value => <Pressable key={value} accessibilityRole="radio"
        accessibilityState={{ checked: view.leapDayPolicy === value }} onPress={() => onLeapDayPolicy(value)}
        style={{ minHeight: 48, justifyContent: 'center' }}><Text>{t[value]}</Text></Pressable>)}
    </View>}
    {view.editing && <Text>{t.editNotice}</Text>}
    {button(view.editing ? t.saveEdit : t.create, onCreate, blocked)}
    {button(t.cancel, onCancel, false)}<Text>{t.cancelHint}</Text>
    {view.pending && <Text>{t.pending} {view.pending.title} · {view.pending.localDate} · {view.pending.timezone} · {t[view.pending.recurrence]}
      {view.pending.leapDayPolicy && ` · ${t[view.pending.leapDayPolicy]}`}</Text>}
    {view.status === 'retry' && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.list, onList, view.busy)}
    {view.error && <Text>{t.error}</Text>}
    <Text>{t.bound}</Text><Text>{t.manualRefresh}</Text>
    {view.checked && view.dates.length === 0 && <Text>{t.none}</Text>}
    {view.dates.map(date => <View key={date.id} style={{ paddingVertical: 8 }}>
      <Text selectable>{date.title}</Text>
      {button(t.edit, () => onEdit(date.id), blocked)}<Text selectable>{date.localDate} · {date.timezone}</Text>
      <Text>{t[date.recurrence]}{date.leapDayPolicy && ` · ${t[date.leapDayPolicy]}`}</Text>
      <Text>{date.asOfLocalDate === null ? t.unknownToday : `${t.asOf} ${date.asOfLocalDate} · ${date.timezone}`}</Text>
      <Text>{date.nextOccurrence === null ? (date.asOfLocalDate === null ? t.unknownNext : t.noNext)
        : `${t.next} ${date.nextOccurrence}`}</Text>
    </View>)}
  </View>;
}
