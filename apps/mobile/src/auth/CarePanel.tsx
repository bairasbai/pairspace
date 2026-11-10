import { Pressable, Text, View } from 'react-native';
import { careCopy } from './careCopy';
import { HeartButton } from '../HeartButton';
import type { CareView } from './care';
export function CarePanel({ locale, view, onSend, onRead, showSend = true }: {
  locale: 'ru' | 'en'; view: CareView; onSend(): void; onRead(): void; showSend?: boolean;
}) {
  if (!view.available) return null;
  const t = careCopy[locale];
  return <View style={{ alignItems: 'center', padding: 16 }}>
    <Text>{t.notice}</Text>
    {showSend && <HeartButton label={t.title} hint={t.hint} onPress={onSend} disabled={view.busy} busy={view.status === 'sending'} />}
    {showSend && <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: view.busy, busy: view.busy }}
      disabled={view.busy} onPress={onRead} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{t.read}</Text></Pressable>
    {view.error && <Text>{t.error}</Text>}
    {view.checked && <Text>{view.incoming ? t.incoming : t.none}</Text>}
  </View>;
}
