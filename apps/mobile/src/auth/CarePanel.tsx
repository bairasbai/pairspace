import { Pressable, Text, View } from 'react-native';
import { HeartButton } from '../HeartButton';
import type { CareView } from './care';
const copy = {
  ru: {
    title: 'Думаю о тебе', hint: 'Сохранить тестовый знак заботы для партнёра',
    notice: 'Тестовый знак заботы. Без push, геолокации, присутствия и отметок прочтения.',
    idle: 'Нажмите сердце, чтобы отправить знак заботы.', sending: 'Отправляется…',
    retry: 'Подтверждение не получено. Нажмите сердце для повтора того же знака без дубля.',
    sent: 'Сохранено на сервере. Доставка и прочтение не подтверждены.',
    unavailable: 'Тестовая функция заботы недоступна на этом сервере.',
    cooldown: 'Новый знак можно отправлять не чаще раза в минуту. Попробуйте позже.',
    read: 'Проверить знак от партнёра', incoming: 'Партнёр отправил «Думаю о тебе».',
    none: 'Нет доступного знака от партнёра за последние 24 часа.',
    error: 'Не удалось проверить ответ. Можно повторить запрос.',
  },
  en: {
    title: 'Thinking of you', hint: 'Save a test care signal for your partner',
    notice: 'Test care signal. No push, location, presence or read receipts.',
    idle: 'Tap the heart to send a care signal.', sending: 'Sending…',
    retry: 'No acknowledgement received. Tap the heart to retry the same signal without a duplicate.',
    sent: 'Saved on the server. Delivery and reading are not confirmed.',
    unavailable: 'The test care feature is unavailable on this server.',
    cooldown: 'You can send a new signal once per minute. Try again later.',
    read: 'Check for a partner signal', incoming: 'Your partner sent “Thinking of you”.',
    none: 'No available partner signal from the last 24 hours.',
    error: 'Could not verify the response. You can retry.',
  },
};
export function CarePanel({ locale, view, onSend, onRead }: {
  locale: 'ru' | 'en'; view: CareView; onSend(): void; onRead(): void;
}) {
  if (!view.available) return null;
  const t = copy[locale];
  return <View style={{ alignItems: 'center', padding: 16 }}>
    <Text>{t.notice}</Text>
    <HeartButton label={t.title} hint={t.hint} onPress={onSend} disabled={view.busy} busy={view.status === 'sending'} />
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: view.busy, busy: view.busy }}
      disabled={view.busy} onPress={onRead} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{t.read}</Text></Pressable>
    {view.error && <Text>{t.error}</Text>}
    {view.checked && <Text>{view.incoming ? t.incoming : t.none}</Text>}
  </View>;
}
