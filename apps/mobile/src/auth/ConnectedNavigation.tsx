import { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Navigation, type Tab } from '../Navigation';
import { copy, type Locale } from '../copy';
import { colors } from '../theme';
import { careCopy } from './careCopy';
import type { SessionController } from './SyntheticChatConnected';

const reasons = {
  ru: {
    signedOut: 'Войдите в тестовый аккаунт во вкладке «Чат».',
    waiting: 'Знак заботы станет доступен после присоединения партнёра.',
    blocked: 'Для знака заботы нужна подтверждённая активная пара. Откройте «Чат».',
    busy: 'Проверяем тестовый аккаунт…',
  },
  en: {
    signedOut: 'Sign in to a test account in the Chat tab.',
    waiting: 'Care signals become available when your partner joins.',
    blocked: 'A verified active pair is required. Open Chat.',
    busy: 'Checking the test account…',
  },
};
/** The injected controller is the sole authority and send path on every tab. */
export function ConnectedNavigation({ controller, locale, selected, onSelect }: {
  controller: SessionController; locale: Locale; selected: Tab; onSelect(tab: Tab): void;
}) {
  const auth = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const care = useSyncExternalStore(controller.care.subscribe, controller.care.getSnapshot);
  const t = careCopy[locale], reason = reasons[locale];
  const allowed = care.available && auth.phase === 'signed_in';
  const status = allowed ? t[care.status] : auth.phase === 'signed_out' ? reason.signedOut
    : auth.phase === 'busy' ? reason.busy : auth.error === 'context_waiting_partner' ? reason.waiting : reason.blocked;
  return <View>
    <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
    <Navigation selected={selected} onSelect={onSelect} text={copy[locale]}
      heart={{ hint: allowed ? t.hint + ' ' + status : status, disabled: !allowed || care.busy, busy: care.busy }}
      onHeart={() => { if (allowed) void controller.care.send(); }} />
  </View>;
}
const styles = StyleSheet.create({
  status: { color: colors.muted, backgroundColor: colors.surface, fontSize: 12,
    textAlign: 'center', paddingHorizontal: 16, paddingVertical: 8 },
});
