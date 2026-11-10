import { Pressable, Text, TextInput, View } from 'react-native';
import { tasksCopy } from './tasksCopy';
import type { TasksView } from './tasks';
export function TasksPanel({ locale, view, onDraft, onCreate, onRetry, onList, onComplete, onReopen, onCancel }: {
  locale: 'ru' | 'en'; view: TasksView; onDraft(text: string): void; onCreate(): void;
  onRetry(): void; onList(): void; onComplete(id: string): void; onReopen(id: string): void; onCancel(): void;
}) {
  if (!view.available) return null;
  const t = tasksCopy[locale];
  const blocked = view.busy || view.requiresRefresh || view.pending !== null;
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action}
    style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    <TextInput accessibilityLabel={t.draft} value={view.draft} onChangeText={onDraft}
      maxLength={800} autoCorrect={false} style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    {button(t.create, onCreate, blocked)}
    {button(t.cancel, onCancel, false)}<Text>{t.cancelHint}</Text>
    {view.pending && <Text>{t.pending} {t[view.pending.operation]} · {view.pending.title}</Text>}
    {view.status === 'retry' && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.list, onList, view.busy)}
    {view.error && <Text>{t.error}</Text>}
    <Text>{t.bound}</Text>
    {view.checked && view.tasks.length === 0 && <Text>{t.none}</Text>}
    {view.tasks.map((task, index) => <View key={task.id} style={{ paddingVertical: 8 }}>
      <Text selectable>{task.title}</Text><Text>{t[task.state]}</Text>
      {button(`${task.state === 'open' ? t.complete : t.reopen} ${index + 1}`,
        () => task.state === 'open' ? onComplete(task.id) : onReopen(task.id), blocked)}
    </View>)}
  </View>;
}
