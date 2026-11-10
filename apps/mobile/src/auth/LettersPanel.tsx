import { Pressable, Text, TextInput, View } from 'react-native';
import { lettersCopy } from './lettersCopy';
import type { LettersView } from './letters';
export function LettersPanel({ locale, view, onDraft, onSend, onList, onOpen, onClose }: {
  locale: 'ru' | 'en'; view: LettersView; onDraft(text: string): void; onSend(): void;
  onList(): void; onOpen(id: string): void; onClose(): void;
}) {
  if (!view.available) return null;
  const t = lettersCopy[locale];
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled: view.busy, busy: view.busy }} disabled={view.busy}
    onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    <TextInput accessibilityLabel={t.draft} value={view.draft} onChangeText={onDraft}
      multiline maxLength={16000} autoCorrect={false} style={{ minHeight: 96, borderWidth: 1, padding: 8 }} />
    {button(view.status === 'retry' ? t.again : t.send, onSend)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.list, onList)}
    {view.error && <Text>{t.error}</Text>}
    {view.checked && <Text>{view.letters.length ? t.bound : t.none}</Text>}
    {view.letters.map((letter, index) => <View key={letter.id}>
      {button(`${t.open} ${index + 1}`, () => onOpen(letter.id))}
    </View>)}
    {view.opened && <Text selectable>{view.opened.body}</Text>}
    {view.checked && <Pressable accessibilityRole="button" onPress={onClose}
      style={{ minHeight: 48, justifyContent: 'center' }}><Text>{t.close}</Text></Pressable>}
  </View>;
}
