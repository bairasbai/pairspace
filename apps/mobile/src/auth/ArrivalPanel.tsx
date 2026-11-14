import { Pressable, Text, TextInput, View } from 'react-native';
import type { ArrivalFields, ArrivalView } from './arrival-state';
const copy = {
  ru: { title: 'План прибытия', notice: 'Введённый вами план, не бронирование и не подтверждение рейса или встречи. Оба участника тестовой пары могут его менять. Письма и периоды разлуки не сдвигаются.',
    label: 'Название плана (необязательно)', localDate: 'Дата прибытия YYYY-MM-DD', localTime: 'Местное время HH:mm', timezone: 'Пояс прибытия IANA', offset: 'Смещение UTC ±HH:mm',
    load: 'Проверить план', edit: 'Заполнить форму из проверенного плана', save: 'Сохранить план для обоих', cancel: 'Очистить форму', retryButton: 'Повторить ту же команду',
    missing: 'План не задан на момент проверки.', unknown: 'План ещё не проверен.', asOf: 'Проверено сервером:',
    past: 'Указанное время прошло на момент проверки. Это не означает, что человек прибыл.',
    limits: 'Удаление, отмена плана и история изменений пока недоступны. Очистка формы не отменяет отправленное сохранение. Проверка ручная, не отслеживание рейса.',
    pending: 'Неизменяемая команда ожидает подтверждения:', idle: 'Время 2000–2100; смещение должно соответствовать поясу. При переводе часов выбор смещения явный.',
    saving: 'Сохраняем…', saved: 'План сохранён для обоих.', retry: 'Результат неизвестен.', invalid: 'Проверьте название, дату, время, пояс и смещение; для изменения загрузите план в форму.',
    conflict: 'План изменился. Проверьте его и заполните форму заново.', unavailable: 'План недоступен.', error: 'Не удалось подтвердить актуальное состояние.' },
  en: { title: 'Arrival plan', notice: 'A manually entered plan, not a booking or confirmation of a flight or meeting. Either test-pair member can edit it. Letters and separation periods do not move.',
    label: 'Plan label (optional)', localDate: 'Arrival date YYYY-MM-DD', localTime: 'Local time HH:mm', timezone: 'Arrival IANA time zone', offset: 'UTC offset ±HH:mm',
    load: 'Check plan', edit: 'Fill form from checked plan', save: 'Save plan for both', cancel: 'Clear form', retryButton: 'Retry same command',
    missing: 'No plan set at the check time.', unknown: 'Plan not checked yet.', asOf: 'Server checked at:',
    past: 'The entered time had passed at the check time. This does not mean the person arrived.',
    limits: 'Plan deletion, cancellation and change history are not available yet. Clearing the form does not undo a submitted save. Manual refresh, not flight tracking.',
    pending: 'Unchanged command awaiting confirmation:', idle: 'Time in 2000–2100; offset must match the zone. Clock changes require an explicit offset choice.',
    saving: 'Saving…', saved: 'Plan saved for both.', retry: 'Outcome unknown.', invalid: 'Check label, date, time, zone and offset; load the plan into the form to edit.',
    conflict: 'Plan changed. Check it and fill the form again.', unavailable: 'Plan unavailable.', error: 'Could not confirm the current state.' },
};
export function ArrivalPanel({ locale, view, onField, onSave, onRetry, onLoad, onEdit, onCancel }: {
  locale: 'ru' | 'en'; view: ArrivalView; onField(key: keyof ArrivalFields, value: string): void;
  onSave(): void; onRetry(): void; onLoad(): void; onEdit(): void; onCancel(): void;
}) {
  if (!view.available) return null;
  const t = copy[locale], blocked = view.busy || view.pending !== null || view.requiresRefresh;
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    {button(t.load, onLoad, view.busy)}
    {!view.checked && <Text>{t.unknown}</Text>}
    {view.checked && !view.plan && <Text>{t.missing}</Text>}
    {view.asOf && <Text>{t.asOf} {view.asOf}</Text>}
    {view.plan && <View><Text selectable>{view.plan.label || t.title} · {view.plan.localDate} {view.plan.localTime} · {view.plan.timezone} {view.plan.offset}</Text>
      {view.asOf && view.plan.arrivesAt <= view.asOf && <Text>{t.past}</Text>}</View>}
    {button(t.edit, onEdit, blocked || !view.checked)}
    {(['label', 'localDate', 'localTime', 'timezone', 'offset'] as const).map(key => <TextInput key={key} accessibilityLabel={t[key]} value={view.fields[key]}
      onChangeText={value => onField(key, value)} maxLength={key === 'label' ? 800 : key === 'timezone' ? 100 : key === 'localDate' ? 10 : key === 'offset' ? 6 : 5}
      autoCapitalize="none" autoCorrect={false} style={{ minHeight: 48, padding: 8, borderWidth: 1 }} />)}
    {button(t.save, onSave, blocked)}{button(t.cancel, onCancel, false)}
    {view.pending && <Text>{t.pending} {view.pending.label} · {view.pending.localDate} {view.pending.localTime} · {view.pending.timezone} {view.pending.offset}</Text>}
    {view.status === 'retry' && button(t.retryButton, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.limits}</Text>
  </View>;
}
