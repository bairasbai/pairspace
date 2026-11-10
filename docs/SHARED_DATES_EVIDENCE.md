# Общие однократные даты: доказательства synthetic-среза

## Граница и статус
База: опубликованный a24d242c62f1ee84d386af80e65e7d99080baba4,
равный по tree 19229f4517f10c6324178830d476b5880efab444 локальному ad81cae.
До независимой проверки точного финального SHA: **не принято**.
Никакой публикации, production, preview, личных данных или внешнего календаря.

Явное «Поделиться датой» любым активным участником сохраняет общую запись
для обоих. Это не приглашение и не согласование встречи. Только create/list,
без edit/delete, повторений, ежегодных дней рождения, напоминаний и отсчёта.
Последние 50 по created_at DESC/id DESC, не ближайшие 50 и не полный архив.
Default Kimi/offline не меняется, connected area остаётся synthetic opt-in.

## Проверяемые гарантии
- Календарный YYYY-MM-DD 0001–9999 проверяется григорианскими правилами, хранится
  текстом; leap year, невозможные дни, DST даты Tokyo/Los_Angeles не сдвигаются.
- Точное IANA-имя проверяется Intl и серверным pg_timezone_names. Никакой
  canonical rewrite. Разные aliases — разные immutable payload, смена alias
  того же command приводит к conflict. Регистр не исправляется молча.
- Создание и replay связывают actor+command с title/date/zone/pair/epoch.
  Database guards запрещают UPDATE/DELETE записи и receipt; FK связывает тело.
- Lock order users→pair, две текущие membership и повторная свежая provider/session
  проверка после ожидания. Expired/revoked/closed/foreign/new-pair запросы закрыты.
- createdAt серверный, ms precision. При равных timestamp порядок UUID устойчив.
- RAM-черновик не отправляется автоматически. После неизвестного ACK новая правка
  не меняет исходную команду; повтор сохраняет title/date/zone, включая alias spelling.
- Cookie/context/session/scope смена и поздние ответы не возвращают старые данные.
- Заголовок не попадает в URL, outbox, уведомления или application logs.

## Проверки автора
- API: 33 suites, 231 tests passed; statements/branches/functions/lines
  99.35/98.78/100/99.91%.
- Mobile: 51 suites, 1383 tests passed; 96.98/96.07/98.17/98.57%.
- Real PostgreSQL: 180/180 passed, включая 14 новых date boundary сценариев.
- TypeScript и lint API/mobile passed; root 9/9 и safety 9/9 passed.
- iOS и Android JS exports passed, не native build.
- Полный BASE→HEAD diff-check, лимит 600 строк handwritten, secret-pattern scan
  и неизменность source hashes после финальной заморозки passed.
- Archive/patch exact-tree и SHA256 проверяются при передаче в отдельном manifest.
Логи API/PG/root: `docs/evidence/shared-dates/`.
Mobile: `apps/mobile/evidence/shared-dates/`.

Первый полный PostgreSQL прогон выявил ошибку новой тестовой композиции:
opt-in shared dates не передавался fixture в приложение, поэтому HTTP отвечал 404.
Исправлен fixture, затем полный набор запущен заново. Это не обход auth и не
изменение product defaults. Первые результаты до изменения timezone-контракта
не используются как финальное подтверждение. Во время первого прогона также
изменялось имя domain export; один mobile import попал в промежуточное состояние.
Финальный прогон выполняется после согласования точного timezone-контракта.

## Не запускалось / ограничения
Native iOS/Android сборки, физические устройства, VoiceOver/TalkBack, клавиатуры,
Hermes Intl timezone availability и два устройства не проверены. JS exports
не означают native acceptance. Device clock не используется для countdown:
срез не утверждает authoritative «сегодня», оставшиеся дни или наступление даты.

Root Next build имеет прежний blocker `next: not found`; зависимости референса
не устанавливались/не менялись. Mobile/API локальные dependencies скопированы
из прежнего проверяемого workspace; package manifests/lockfiles неизменны.
PostgreSQL runner отверг symlink dependency root, затем использована локальная
копия без изменения ограничений runner. Новых dependencies нет.

Server plaintext, E2EE не заявлена. Архив после закрытия пары сохраняется по
прежней политике, но create/list/replay закрытой пары недоступны. Retention,
production/security deployment и будущие migrations при изменении timezone
catalog требуют отдельного решения. Неподдерживаемая зона отклоняется явно.
