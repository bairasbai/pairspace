/** Original neutral prompts, not copied from the reference application's catalogue.
 * Version 1 is permanent: future catalogues must be additive, never edit this mapping.
 */
export const DAILY_CATALOG_VERSION = 'amio-daily-v1';
const prompts = [
  { id: 'small-discovery', ru: 'Какое маленькое открытие сегодня привлекло твоё внимание?', en: 'What small discovery caught your attention today?' },
  { id: 'comfortable-pace', ru: 'В каком темпе тебе было бы приятно провести ближайший свободный час?', en: 'What pace would feel good for your next free hour?' },
  { id: 'ordinary-detail', ru: 'Какую обычную деталь вокруг себя тебе хотелось бы показать мне сегодня?', en: 'What ordinary detail around you would you like to show me today?' },
  { id: 'try-together', ru: 'Какую простую вещь тебе было бы любопытно когда-нибудь попробовать вместе?', en: 'What simple thing would you be curious to try together someday?' },
  { id: 'gentle-change', ru: 'Какое небольшое изменение сделало бы твой завтрашний день удобнее?', en: 'What small change would make tomorrow more comfortable for you?' },
  { id: 'unexpected-smile', ru: 'Что могло бы неожиданно вызвать у тебя улыбку в обычный день?', en: 'What might unexpectedly make you smile on an ordinary day?' },
  { id: 'keep-a-moment', ru: 'Какой момент этой недели тебе хотелось бы сохранить в памяти?', en: 'What moment from this week would you like to remember?' },
] as const;
const anchor = Date.parse('2026-01-01T00:00:00.000Z');
export function canonicalDailyDate(value: unknown): value is string {
  return typeof value === 'string' && !value.startsWith('0000-') && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00.000Z'))
    && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
}
export function dailyPrompt(day: unknown, version: unknown = DAILY_CATALOG_VERSION) {
  if (!canonicalDailyDate(day) || version !== DAILY_CATALOG_VERSION) return null;
  const ordinal = Math.floor((Date.parse(day + 'T00:00:00.000Z') - anchor) / 86400000);
  const prompt = prompts[((ordinal % prompts.length) + prompts.length) % prompts.length];
  return Object.freeze({ catalogVersion: DAILY_CATALOG_VERSION, promptId: prompt.id, promptRU: prompt.ru, promptEN: prompt.en });
}
