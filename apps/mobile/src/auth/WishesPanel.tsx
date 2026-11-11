import { Pressable, Text, TextInput, View } from 'react-native';
import { wishesCopy } from './wishesCopy';
import type { WishesView } from './wishes';
export function WishesPanel({ locale, view, onDraft, onExplanation, onConsent, onCreate, onRetry, onList, onFulfill, onReopen, onCancel }: {
  locale: 'ru' | 'en'; view: WishesView; onDraft(text: string): void; onExplanation(text: string): void; onConsent(value: boolean): void; onCreate(): void;
  onRetry(): void; onList(): void; onFulfill(id: string): void; onReopen(id: string): void; onCancel(): void;
}) {
  if (!view.available) return null;
  const t = wishesCopy[locale];
  const blocked = view.busy || view.requiresRefresh || view.pending !== null;
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action}
    style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    <TextInput accessibilityLabel={t.draft} value={view.draft} onChangeText={onDraft}
      maxLength={1600} autoCorrect={false} style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel={t.explanation} value={view.explanation} onChangeText={onExplanation}
      multiline maxLength={1201} style={{ minHeight: 96, borderWidth: 1, padding: 8 }} />
    <Pressable accessibilityRole="checkbox" accessibilityLabel={t.consent} accessibilityState={{ checked: view.consent }}
      onPress={() => onConsent(!view.consent)} style={{ minHeight: 48, justifyContent: 'center' }}>
      <Text>{view.consent ? '☑ ' : '☐ '}{t.consent}</Text>
    </Pressable>
    {button(t.create, onCreate, blocked || !view.consent)}
    {button(t.cancel, onCancel, false)}<Text>{t.cancelHint}</Text>
    {view.pending && <Text>{t.pending} {t[view.pending.operation]} · {view.pending.title}{'\n'}{view.pending.explanation}</Text>}
    {view.status === 'retry' && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.list, onList, view.busy)}
    {view.error && <Text>{t.error}</Text>}
    <Text>{t.bound}</Text>
    {view.checked && view.wishes.length === 0 && <Text>{t.none}</Text>}
    {view.wishes.map((wish, index) => <View key={wish.id} style={{ paddingVertical: 8 }}>
      <Text selectable>{wish.title}</Text><Text selectable>{wish.explanation}</Text><Text>{t[wish.state]}</Text>
      {button(`${wish.state === 'open' ? t.fulfill : t.reopen} ${index + 1}`,
        () => wish.state === 'open' ? onFulfill(wish.id) : onReopen(wish.id), blocked || wish.version >= 2147483647)}
    </View>)}
  </View>;
}
