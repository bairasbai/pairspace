import { Pressable, Text, TextInput, View } from 'react-native';
import { nextDay, partingProgress, type PartingsView } from './partings-state';
const copy = {
  ru: { title: 'Периоды разлуки', notice: 'Тестовая пара: оба могут менять даты. Это отдельный план, не рейс и не расписание писем.',
    draft: 'Название периода', start: 'Начало YYYY-MM-DD', end: 'Последний день разлуки YYYY-MM-DD', zone: 'Пояс периода IANA',
    create: 'Сохранить период для обоих', edit: 'Изменить период', save: 'Сохранить изменения для обоих', cancel: 'Очистить форму',
    cancelHint: 'Очистка формы не отменяет уже отправленное сохранение.', pending: 'Неизменяемая команда ожидает подтверждения:',
    refresh: 'Обновить периоды', again: 'Повторить ту же команду', asOf: 'Проверено сервером:', stale: 'Отсчёт только на момент проверки. Обновите вручную. Период заканчивается после последнего дня разлуки; это не подтверждение встречи. Нельзя пересекать календарные дни или реальные интервалы даже в разных поясах. Неоднозначная или отсутствующая полночь отклоняется, не сдвигается.',
    none: 'Сейчас нет разлуки по проверенному плану.', bound: 'Полный список, максимум 100 периодов. Удаление пока недоступно.',
    current: 'До окончания периода, календарных дней:', upcoming: 'До начала, календарных дней:', past: 'Период завершён на момент проверки.',
    idle: 'Даты включают первый и последний день разлуки.', saving: 'Сохраняем…', retry: 'Результат неизвестен.', saved: 'Период сохранён для обоих.',
    invalid: 'Проверьте название, даты 2000–2100 и пояс. Начало не позже конца.', conflict: 'Конфликт версии, пересечение или лимит. Обновите список и выберите период заново.',
    unavailable: 'Периоды недоступны.', error: 'Не удалось подтвердить актуальный список.' },
  en: { title: 'Separation periods', notice: 'Test pair: either partner may edit dates. This is a separate plan, not a flight or letter schedule.',
    draft: 'Period title', start: 'Start YYYY-MM-DD', end: 'Last separation day YYYY-MM-DD', zone: 'Period IANA time zone',
    create: 'Save period for both', edit: 'Edit period', save: 'Save changes for both', cancel: 'Clear form',
    cancelHint: 'Clearing the form does not undo a submitted save.', pending: 'Unchanged command awaiting confirmation:',
    refresh: 'Refresh periods', again: 'Retry same command', asOf: 'Server checked at:', stale: 'Countdown is only current at the check time. Refresh manually. The period ends after its last day; this does not confirm a meeting. Calendar labels and real intervals cannot overlap, even across zones. Ambiguous or missing midnight is rejected, never shifted.',
    none: 'No current separation in the checked plan.', bound: 'Complete list, maximum 100 periods. Deletion is not available yet.',
    current: 'Calendar days until the period ends:', upcoming: 'Calendar days until start:', past: 'Period ended at the check time.',
    idle: 'Dates include the first and last separation day.', saving: 'Saving…', retry: 'Outcome unknown.', saved: 'Period saved for both.',
    invalid: 'Check title, dates in 2000–2100 and zone. Start must not follow end.', conflict: 'Version conflict, overlap or capacity limit. Refresh and select the period again.',
    unavailable: 'Periods unavailable.', error: 'Could not confirm the current list.' },
};
export function PartingsPanel({ locale, view, onDraft, onStartDate, onEndDate, onTimezone, onCreate, onRetry, onList, onCancel, onEdit }: {
  locale: 'ru' | 'en'; view: PartingsView; onDraft(text: string): void; onStartDate(text: string): void; onEndDate(text: string): void;
  onTimezone(text: string): void; onCreate(): void; onRetry(): void; onList(): void; onCancel(): void; onEdit(id: string): void;
}) {
  if (!view.available) return null;
  const t = copy[locale], blocked = view.busy || view.pending !== null || view.requiresRefresh;
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    {([[t.draft, view.draft, onDraft, 800], [t.start, view.startDate, onStartDate, 10], [t.end, view.endDate, onEndDate, 10], [t.zone, view.timezone, onTimezone, 100]] as const).map(([label, value, change, maxLength]) => <TextInput key={label} accessibilityLabel={label} value={value} onChangeText={change} maxLength={maxLength} autoCorrect={false} autoCapitalize="none" style={{ minHeight: 48, padding: 8, borderWidth: 1 }} />)}
    {button(view.editing ? t.save : t.create, onCreate, blocked)}
    {button(t.cancel, onCancel, false)}<Text>{t.cancelHint}</Text>
    {view.pending && <Text>{t.pending} {view.pending.title} · {view.pending.startDate}–{view.pending.endDate} · {view.pending.timezone}</Text>}
    {view.status === 'retry' && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.refresh, onList, view.busy)}{view.error && <Text>{t.error}</Text>}
    <Text>{t.bound}</Text><Text>{t.stale}</Text>
    {view.asOf && <Text>{t.asOf} {view.asOf}</Text>}
    {view.checked && view.asOf && !view.partings.some(p => partingProgress(p, view.asOf!).state === 'current') && <Text>{t.none}</Text>}
    {view.partings.map(p => { const progress = view.asOf ? partingProgress(p, view.asOf) : null;
      return <View key={p.id}><Text>{locale === 'ru' ? 'Окончание периода:' : 'Period ends:'} {nextDay(p.endDate)} · {p.timezone}</Text><Text selectable>{p.title} · {p.startDate}–{p.endDate} · {p.timezone}</Text>
        {button(t.edit, () => onEdit(p.id), blocked)}
        {progress && <Text>{t[progress.state]} {progress.state !== 'past' ? progress.days : ''}</Text>}
      </View>;
    })}
  </View>;
}
