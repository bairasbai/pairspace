# План реализации и приёмки

## Проверено сейчас
- [x] Репозиторий main ccbe5df и веб-концепт Kimi сохранены.
- [x] Нейтральное ядро дат/текста/разлук; девять существующих тестов проходят.
- [ ] Восстановленный пакет документации принят независимым reviewer и опубликован.
- [ ] Expo-код заново восстановлен и принят; прежние неопубликованные файлы не найдены.

## Этап 1 — фундамент Expo
Создать отдельный mobile package, RU/EN, tokens, навигацию и сердце с reduced-motion.
Доменная логика/контракты отделены от UI; coverage включает все исходники.
Exit: typecheck/lint, ≥90% четыре метрики, оба native build и базовая навигация проверены.
До выполнения gate это прототип, не работающий продукт.

## Этап 2 — аккаунт и пара
Выбрать auth/БД, отдельное staging; миграции и rollback; invite/accept/logout/unpair.
Exit: две пары не пересекаются по API, storage, realtime, cache и фоновой работе.

## Этап 3 — общение P0
Приватный чат + письма + сердце + countdown. Outbox, retries, ACK, history cursor.
Exit: S02–S05/S12 на двух устройствах, после рестарта и reconnect, без дублей/утечек.
До реальных личных сообщений закрыть решение E2EE и политику восстановления.

## Этап 4 — полнота Tan Ata и быт
Сверить каждый режим TAN_ATA_MAP с исходным кодом; реализовать разговоры/желания/альбом/игры,
задачи/покупки/календарь/поддержку по модулям, с независимой приёмкой каждого.
Exit: нет потерянных сценариев; права/удаление определены для каждой сущности.

## Этап 5 — финансы и дополнительные возможности
Учёт бюджета, цели, виджеты, optional AI, медиа/голосовые согласно контрактам и согласиям.
Никаких настоящих банковских операций без отдельного проекта и правовых оснований.

## Этап 6 — пилот и запуск
Рынок/возраст/название/правовые документы; резервное восстановление; нагрузка;
security review; store privacy labels; crash/alerting без приватного контента; rollback.
Оплата, массовые приглашения, release stores и deploy согласуются отдельно.

## Правило статуса
Каждая задача: pending → implementing → verification → independent review → accepted.
Отдельные тесты не переводят весь этап в accepted. Публикация docs не завершает разработку.

### Прогресс первого среза, не закрытие Этапа 1
В отдельной ветке восстановлен Expo preview: RU/EN, четыре вкладки, сердце/reduced-motion,
пробный черновик без сети. Мобильные unit/typecheck/lint и JS export проходят.
Native builds, два устройства, визуальная приёмка и глобальный coverage остаются открыты.

### Локальное ядро исходящих чата
Создан и unit-проверен scoped immutable reducer для очереди/ACK/retry/удаления.
Это подготовка Этапа 3, не его закрытие: серверная проверка пары, доставка, история и receipts отсутствуют.

### SQL-backed срез, не завершение auth/чата
services/api выполняет send/history/close в SQL-транзакциях; тесты PGlite проверяют
изоляцию двух пар, ограничения, idempotency, rollback и persistence. Auth/HTTP/worker не подключены.
До настоящего сервера обязательны multi-session PostgreSQL race tests, RLS/roles и независимая приёмка.

### Transport prototype, не запуск сервиса
Добавлен in-process Request/Response handler с обязательным verifier interface и клиентский adapter.
Synthetic tokens существуют только в тестах. Нет auth provider, listener, UI-соединения или prod deploy.
Временный протокол отличается от v1; см. services/api/TRANSPORT.md.

### Signed synthetic auth prototype
Проверка jose/ES256 и SQL session/identity добавляются без provider/login/token issuance.
Повторная проверка session/user в usecase transaction закрывает lookup→write gap;
реальные PostgreSQL concurrency, auth lifecycle и независимая приёмка остаются открыты.

## UI preview checkpoint
First visual slice implemented: Today / Together / letters / calendar / memories,
RU/EN demo content, nested navigation and draft preservation. Not ready for release:
no real data, editing, sending, scheduling, notifications, media or native acceptance.
Chat remains the existing practice composer pending backend and chosen UI integration.
Next: real data wiring, visual/device QA and accessible focus/keyboard checks.

## Subscription domain checkpoint
Reference catalogue and pure entitlement tests implemented without payment SDKs.
Before billing: decide paid feature list, breakup/transfer and renewal policies;
implement provider verification, ownership, one-per-pair transaction constraints,
idempotent events and restore. Free chat/history/security must remain unaffected.

## Проверка полноты переноса Tan Ata
Перед реализацией сверять [TAN_ATA_MAP.md](TAN_ATA_MAP.md): 11 режимов разговоров,
песни, капсула, шаги, дневник, небо, воспоминание дня, погода, путь, присутствие,
день встречи и управление письмами/разлуками/рейсом. UI-демо не закрывает эти этапы.
По решению владельца от 10 ноября 2026 весь Tan Ata включён в итоговый объём,
включая астрологию/нумерологию (P2), с улучшениями под независимые пары.
P0/P1/P2 задают последовательность, не право исключать исходную функцию.
Новые найденные сценарии добавляются в карту; личные данные и однопарная модель не переносятся.
До P2 необходимы ACL, согласие/видимость, удаление и спецификация расчётов.
Exit gate: добровольный минимальный ввод без скрытых импортов, отказ без потери основных
функций, тесты двух пар/отзыва/удаления и дат/поясов, развлекательная маркировка без
научных, диагностических или рекомендательных обещаний. См. PRODUCT_BACKLOG.md.
Текущий preview остаётся демо; эта правка не реализует функции.

## Kimi styling alignment
See [KIMI_DESIGN_ALIGNMENT](KIMI_DESIGN_ALIGNMENT.md): bounded mobile palette/typography/navigation styling.
Device visual acceptance remains open; no backend features added.

## Синтетический mobile invitation flow
Реализован opt-in клиент выпуска/метаданных/отзыва и ручного preview → consent → accept.
Проверяются повторные запросы, lost ACK, смена cookie/сеанса/области и две учётные
записи через реальный loopback PostgreSQL → активная пара → чат.
См. [контракт](../apps/mobile/PAIR_INVITATIONS.md). Независимая приёмка ожидается.
Следующие отдельные gates: native iOS/Android и два устройства, lifecycle/background,
production доставка, abuse/rate limits, конфигурация и deployment/security review.

## Ограниченный шаг: synthetic chat recovery
- [x] RAM-only immutable command, явный retry без нового ID после неизвестного ACK.
- [x] Редактируемый draft отдельно; transient discovery/history не стирают его.
- [x] RU/EN sending/retry/sent; server ACK не является delivery/read receipt.
- [x] Disposable PostgreSQL lost-response replay: одна message/outbox запись.
- [ ] Независимая приёмка точного SHA этого шага.
- [ ] Native iOS/Android и два устройства, durable restart recovery, production gate.
Контракт и ограничения: [CHAT_RECOVERY](../apps/mobile/CHAT_RECOVERY.md).

### Synthetic bounded draft contract, not durable product persistence
Verified-context/binding, stale-operation suppression, terminal consume-before-send
and injected-store restart harness implemented. No native adapter or App wiring.
Next gate: durable logout/revocation/install policy, full controller integration,
platform failure/size/backup testing and independent acceptance. 8k chat drafts
are not claimed to fit the experiment's 2KiB full-envelope persistence limit.

## 2026-11-10 — окно старой истории (не принято)
- [x] Синтетический мобильный RU/EN Load older: cursor, retry, конец, лимит 200.
- [x] Refresh показывает последние 50 с явным предупреждением о сбросе окна.
- [x] Unit/renderer сценарии lifecycle, конфликтов и гонок; real PostgreSQL >50 rows.
- [ ] Независимая проверка точного финального SHA и физические iOS/Android сценарии.
- Без production rollout, бесконечного архива, удаления, realtime или receipts.

## 2026-11-10 — отдельный synthetic сигнал заботы
- [x] Реализовано фиксированное «Думаю о тебе» между двумя активными участниками.
- Явная отправка и явное чтение входящего сигнала, replay после unknown ACK.
- SQL-сессия/пара/epoch проверяются заново; 60с продуктовый cooldown сериализован.
- 24ч окно видимости не удаляет dedup journal и не устанавливает retention policy.
- Не закрыты: независимая приёмка SHA, реальные iOS/Android и два устройства,
  restart persistence, политика удаления, abuse defence, production rollout.
- Доказательства: [CARE_SIGNAL_EVIDENCE](CARE_SIGNAL_EVIDENCE.md).

## Центральное сердце — synthetic checkpoint 2026-11-10
- Реализовано: общий care controller всех вкладок, одна центральная кнопка, RU/EN
  причины недоступности, busy/retry/cooldown и подтверждение только сохранения сервером.
- Проверено локально: App/navigation, смена controller/вкладки/языка, StrictMode,
  logout/unmount и offline default; [доказательства](CENTRAL_HEART_EVIDENCE.md).
- Открыто: независимая приёмка frozen SHA, native iOS/Android и два устройства,
  production-сервер, push и долговечное восстановление. JS export не native build.

## Ограниченный шаг: немедленные synthetic-письма
- RAM-черновик автора → явная send-now команда → входящие метаданные партнёра
  → отдельное открытие тела. Подтверждение сервера не является read receipt.
- Последние 30 входящих; без пагинации и полного архива. Неизменяемый повтор
  после неизвестного ACK, строгая изоляция пары/epoch и очистка клиентской области.
- Отдельные будущие gates: запечатывание/расписание с серверным временем,
  долговечные черновики, ответы, чтения по согласию, правки/удаление и retention.
- Независимая приёмка SHA, native iOS/Android, два устройства и production
  security/deployment gates остаются открыты; [доказательства](LETTERS_EVIDENCE.md).

## Ограниченный шаг: scheduled synthetic-письма
- Явное расписание с offset ISO + IANA, серверный gate тела после lock/session recheck.
- Старые немедленные письма совместимы; неизменяемый retry включает расписание.
- Нет фонового открытия, push или read receipts. Метаданные обновляются явно.
- Окно 60 секунд–366 суток — provisional synthetic policy, не production retention.
- Открыты независимая приёмка SHA, native Intl/RU/EN/accessibility и два устройства,
  durable drafts, ответы/удаление/retention, E2EE и production security/deployment.
- Проверки: [SCHEDULED_LETTERS_EVIDENCE](SCHEDULED_LETTERS_EVIDENCE.md).

## Добровольный выход — ограниченный synthetic-срез
- Active-pair only: явное RU/EN подтверждение, одностороннее завершение без удаления.
- Реализованы общий hardened close primitive, scoped receipt/replay, отзыв обоих членств
  и приглашений, окончательность закрытия и освобождение слотов в одной транзакции.
- UI очищает приватный RAM-контент и сохраняет вход; неизвестный ACK требует повтора
  той же команды. Смена аккаунта/пары не превращает старое подтверждение в новое.
- Waiting-space cancellation, экспорт, production-архив/retention, E2EE, native/device
  QA и внешний пилот не входят в срез. Проверки: [PAIR_LEAVE_EVIDENCE](PAIR_LEAVE_EVIDENCE.md).

## Общие задачи — bounded synthetic-срез
- Явные create/list/complete/reopen для двух участников текущей активной пары.
- RAM-черновик, неизменяемые команды, optimistic version и явный refresh конфликтов.
- Последние 50 задач, детерминированно по созданию; без полного архива и realtime.
- Не входят: assignee, due date, edit/delete, push, production и политика хранения.
- Независимая проверка SHA, native iOS/Android, два устройства и E2EE остаются открыты.
- Доказательства и статус: [SHARED_TASKS_EVIDENCE](SHARED_TASKS_EVIDENCE.md).

### Слепые ответы: повторяемые bounded-раунды Этапа 4
Первый single-round срез расширен явным next только после двух ответов текущего.
Три versioned нейтральных RU/EN вопроса; прежний small-joy v1 не изменён.
Последние десять metadata и отдельное чтение выбранного раунда, не полный архив.
Immutable команды связывают predecessor, вопрос и версию; неизвестный ACK не
создаёт новый раунд, конкурирующая смена требует явного refresh.
Права пропуска: можно не открывать/не отправлять ответ; без напоминаний/давления.
Нет автоматической смены дня/режима, отмены, правки/удаления, терапевтических обещаний.
До независимой приёмки точного SHA: не принято. Native/device/production gates открыты.
Проверки: [BLIND_ROUNDS_EVIDENCE](BLIND_ROUNDS_EVIDENCE.md).

### Общие однократные даты: bounded synthetic-срез
Create/list с явным распространением на обоих участников текущей активной пары.
Григорианская календарная дата и IANA-пояс без UTC day shift, без countdown.
Последние 50 созданных записей, не список ближайших дат и не полный архив.
Это не приглашение, договорённость о свидании или ежегодный день рождения.
Повторения, разлуки/день встречи, редактирование/удаление, reminders и external
calendar ещё не реализованы. Независимая проверка SHA и native/device gates открыты.
Доказательства: [SHARED_DATES_EVIDENCE](SHARED_DATES_EVIDENCE.md).

### Ежегодные общие даты: bounded synthetic-срез
Явный once/annual и нейтральный выбор для 29 февраля: только високосные годы,
28 февраля либо 1 марта. Старые записи остаются once, silent default отсутствует.
Следующая календарная дата вычисляется относительно серверного дня в exact IANA
после проверки доступа, показывается с as-of и обновляется только вручную.
Не раньше anchor; same-day inclusive; Gregorian 1900/2000/2100 и границы 0001–9999.
Никаких reminders, push, countdown, edit/delete или background notifications.
Независимая приёмка frozen SHA и native/device/production gates остаются открыты.
[Доказательства](ANNUAL_DATES_EVIDENCE.md).

## Инженерный checkpoint: воспроизводимая локальная приёмка
Реализован fixed-profile fail-closed runner (docs/VERIFICATION_RUNNER.md).
Exit gate: чистый frozen source, полный machine-readable report, coverage >=90
по четырём метрикам, отсутствие обязательных FAIL/NOT_RUN, независимый reviewer.
Локальный PASS не закрывает native/E2E/production/security exit gates продукта.

## Следующий срез: редактирование общих дат
Реализован локальный кандидат synthetic connected PATCH с version-конфликтами,
immutable retry и каноническим текущим ответом. Явное сохранение для обоих,
RU/EN, сохранение черновика и смена generation/pair/epoch.
Статус: не принято до точного frozen SHA и независимой проверки.
См. DATE_EDITING_EVIDENCE.md. Native/two-device и production не подтверждены.

## Общая хроника: первый текстовый synthetic-срез
Явная публикация неизменяемого воспоминания с заголовком, текстом и датой события;
чтение последних 50 после проверки текущей пары/epoch. Приватный RAM-черновик,
подтверждение видимости партнёру и same-command retry после неизвестного ACK.
Это не «День за днём»: дневник ответов обоих и сегодняшнее blind раскрытие
остаются в плане. Файлы, редактирование/удаление, поиск, export и production
retention/архив не закрыты. Native/device и независимая приёмка остаются открыты.
[Контракт](SHARED_MEMORIES.md), [проверки](SHARED_MEMORIES_EVIDENCE.md).

### Наши песни с объяснениями: bounded synthetic-кандидат
Отдельная title/explanation коллекция, явная публикация партнёру, latest50,
immutable retry/lostACK и scope cleanup реализованы для synthetic mobile→HTTP→PG.
Не закрывает всю строку P1: удаление и ручной порядок остаются планом.
Редактирование автором с подтверждением, version CAS и immutable receipts
добавлено как bounded synthetic-кандидат; [проверки](SONG_EDITING_EVIDENCE.md).
Необязательная HTTPS-ссылка с узким allowlist и явным открытием ОС реализована
как synthetic-кандидат; нет проверки содержимого/редиректов/лицензии. Нет streaming/downloads/lyrics/import/private playlists.
После полного frozen checkpoint требуется независимая приёмка; native/two-device
и production gates остаются открыты. [Контракт](SHARED_SONGS.md).

## Надёжность локального PostgreSQL gate, 2026-11-11
- [x] Измерен baseline: 239.744s при неизменном guard 240s, 215/215 tests PASS.
- [x] Ускорена только подготовка четырёх независимых synthetic accounts; добавлены order/isolation/failure-cleanup regression tests.
- [ ] Полный all-eleven frozen checkpoint и независимая приёмка точного SHA.
- [ ] Native/two-device/production gates остаются открыты; JS export их не закрывает.
Подробности и история неуспехов: POSTGRES_VERIFICATION_RELIABILITY.md.

## Общие желания: первый bounded synthetic-срез
Явная публикация названия/необязательного пояснения обоим; автор и текст
неизменяемые, оба активных участника могут явно отметить исполнение/вернуть.
Version CAS, immutable retries, canonical current state и latest50 реализованы
отдельно от задач. [Контракт](SHARED_WISHES.md), [проверки](SHARED_WISHES_EVIDENCE.md).
Личные желания, редакция/удаление, архив, настройки уведомлений и полный перенос
исходной страницы остаются планом. Без покупок, ссылок и доставки.
До независимого review frozen SHA не принято; native/device/production gates открыты.

## New connected chat history windows

Implementation from exact public base5a998162, not recovery of lost later source. Replace the mobile200-message history barrier with explicit bounded50-message older/newer/oldest/latest navigation. Keep existing send/retry and old history contracts, scoped ID+seq anchors and session denial precedence. Drafts and unknown sends remain separate; the outgoing500-record queue cap remains an explicit separate limitation. Final focused/full/independent acceptance pending: [CHAT_WINDOWS_EVIDENCE](CHAT_WINDOWS_EVIDENCE.md).

## Reply to a specific chat message
Candidate scope: canonical source link, explicit scoped detail outside the current page,
immutable target/body retry, source-unavailable and terminal tombstone handling. No
persisted quote copy. Internal SQL deletion-state tests do not close the user DELETE P0.
Native, durable persistence, realtime and receipts remain open. Exact author/independent
acceptance pending: [CHAT_REPLIES_EVIDENCE](CHAT_REPLIES_EVIDENCE.md).

## User-facing own chat deletion
New candidate from accepted canonical-replies checkpoint54bb956. Explicit confirmation,
author-only CAS and metadata-only immutable retry receipts, terminal tombstone for both
participants. Manual refreshed reads, not realtime; no editing or physical retention purge.
Required full11 and independent acceptance pending: [CHAT_DELETION_EVIDENCE](CHAT_DELETION_EVIDENCE.md).

## User-facing own chat editing
Candidate from independently accepted f6197f8. Explicit Save/Cancel, author-only CAS,
immutable original send/reply identity, current-canonical retries and terminal deletion
priority. Separate edited-version metadata bound500 and existing tombstone bound500
are safety limits per authenticated generation, not an all-memory or realtime claim.
Old clients can fail closed on a replay whose current text was edited. Native builds,
durable queues, sync, delivery/read receipts and retention remain separate unfinished
work. Exact author/independent gates pending: [CHAT_EDITING_EVIDENCE](CHAT_EDITING_EVIDENCE.md).
Owner refinement before acceptance: normalized unchanged saves retain version and do
not mark an untouched message as edited; real edits and restoring original text remain
marked. No-op receipts still protect retries and CAS. Final revised-SHA gates required.

## Personal chat hide/restore
Candidate after independently accepted c6f8db3: personal visibility CAS, explicit
confirmation/restore, complete bounded hidden-metadata navigation and actor-private
revision fencing. No notification or partner-visible hidden metadata. This does not
close durable queue/native restart, realtime, delivery/read receipts or retention work.
Exact frozen full and independent gates required: [CHAT_VISIBILITY](CHAT_VISIBILITY.md).

### Bounded outgoing lifecycle (candidate)
Retire only confirmed receipts (retain50, total500), never unresolved/failed commands.
Explicit local discard can release a stuck attempt but cannot undo a server send.
Late operation results cannot affect new work; current-session revocation still blocks.
See [CHAT_OUTGOING](CHAT_OUTGOING.md). Focused/FULL11/independent acceptance pending.
Durable queue, realtime, native restart and delivery/read receipts remain separate.

### Experimental encrypted recovery (candidate)
Composer plus one immutable pending send/reply, transactional ciphertext journal,
online scope validation and explicit restore/retry. Official Expo SQLite adapter,
existing AES-GCM/SecureStore; no plaintext fallback or history persistence. Linux
process-restart tests do not close native device/backup/reinstall/security gates.
See [CHAT_JOURNAL](CHAT_JOURNAL.md); focused/FULL11/independent acceptance pending.

## Current-window reconciliation candidate
Bounded authorized read snapshot and new-message indicator, explicit and foreground-return
only. Does not add polling, read/delivery receipts, background delivery, native proof or
production rollout. Pending author/independent exact gates; journal remains default-off.

## Morning ritual candidate
Recipient-owned time/zone → explicit future morning → one-time prepared letter → sealed,
available or genuinely missed → bounded full history. No auto promises/notifications,
period links/late fill/edits/cancellation. Independent new implementation; gates pending.

## Morning discussion candidate after accepted ab3de3e
Both participants can explicitly reply under one morning slot, with preserved author
identity and multiline text. Native-sequence bounded30 replacement windows provide
complete history access rather than a first-page-only list. No original-letter copy,
notifications, auto-opening or changes to old chat/letter contracts. Recipient requires
own durable opening; sender release access does not reveal that opening. Slot-scoped
RAM drafts and immutable retries preserve newer text and session isolation. Own reply
editing/deletion, period numbering and translation remain deferred. Implementation and
verification are in progress, not accepted; see MORNING_DISCUSSIONS.md.

## Morning reply mutations candidate
Own CAS edits with explicit save and honest no-op edited marker; explicit confirmed
terminal deletion, immutable original-command retries returning current canonical state.
V2 history retains tombstones and bounded navigation; legacy routes filter deleted
records without leaking bodies. Non-evicting bounded metadata knowledge prevents late
response resurrection; private newer drafts remain unsaved, not canonical. See
MORNING_DISCUSSION_MUTATIONS.md. Implementation/testing pending, not accepted.

## Prepared morning letter editing candidate
After independently accepted c276fcc, add author-only pre-release loading and CAS
editing with explicit Save/Cancel and canonical immutable retry. New no-ops must
also pass deadline and version checks. No recipient opening/edited metadata leaks;
separate RAM editor drafts cannot replace the fill composer. Dual trusted/SQL clock
checks do not claim protection against actual rollback of both clocks. Frozen
FULL11 and independent acceptance pending: [contract](MORNING_PREPARED_EDITING.md).

## Private morning drafts candidate
After accepted prepared-edit4d4ef80, explicit author-only save/load separate from fill
and prepared content. Private text is not published at deadline; CAS/replay preserves
current saved version and newer RAM input. Server-side plaintext with ACL, not E2EE.
No deletion/retention policy, auto-fill or offline durable-storage claim. Frozen full
and independent gates pending: [contract](MORNING_PRIVATE_DRAFTS.md).

## Private morning draft logical removal candidate
After accepted53a1734: explicit confirmed author-only CAS deletion of saved draft,
terminal metadata and no revival through retries/stale ACKs. No restore/recreate in
this slice; ready letters remain unchanged. Logical current-body removal is not
physical DB/backup erasure. Native/production and retention decisions remain open.
[Contract](MORNING_DRAFT_REMOVAL.md), exact author/independent gates pending.

## Separation periods candidate after accepted710a124
Create/list/edit independent all-day separation periods with timezone snapshots,
overlap prevention, version conflict and immutable retries. Complete bounded100 list,
explicit no-current/upcoming/ended state, checked-at server time. Both current active
members can manage periods; not a mutual consent scheduling feature. Letter slots,
numbering/release/ready bodies stay unchanged. Flight, automatic linkage, notifications,
deletion and native/device/production gates remain open. Contract: [PARTINGS](PARTINGS.md).

## Manual arrival plan candidate after accepted a0cb439
One explicit manually entered arrival plan per couple epoch, equal partner create/
read/edit, optional label and explicit local date/time+IANA+offset snapshot. Stable
identity, no-op/CAS and current canonical immutable retries. Past means entered time
has passed, not actual arrival. No airline verification, booking, cancellation,
history, notifications or changes to periods/letters. [Contract](ARRIVAL_PLAN.md).

## Future-notification preferences candidate after accepted2c706114
Private actor/epoch settings with disabled defaults, care/chat/letter opt-ins, fixed
 generic preview and optional IANA quiet interval. Own-rule simulation explicitly is
not event eligibility or delivery. No push/token/OS/provider/worker/queue changes;
existing in-app communication unchanged. [Contract](NOTIFICATION_PREFERENCES.md).

### Care durable capture (pending independent acceptance)
New synthetic care signals atomically capture minimal outbox; trusted one-event simulation
records policy outcome with dedupe and rollback-safe retry. No delivery queue/worker daemon,
push, device tokens or quiet-end scheduling. See docs/CARE_OUTBOX.md for exact limitations.

### Chat notification privacy simulation (awaiting independent acceptance)
Existing event receives atomic scope metadata and one internal privacy observation: deleted or
recipient-hidden sources suppressed; senderhide unrelated. No notification delivery/realtime,
read receipts, historical backfill or copied message content. See CHAT_OUTBOX.md.

### Morning-letter privacy simulation (pending independent acceptance)
Explicit internal slot check uses actual SQL release, not application/device clocks. Before release
no readiness/private-content query; afterward existing prepared content and recipient letter rules
produce immutable historical simulation only. No push, opening, scheduling or delivery queue.

### Shared love dictionary candidate after accepted1a415a0
A real bounded user scenario: explicit shared word plus optional meaning/occasion,
authored editing and confirmed logical removal, complete synthetic100-lifetime list,
CAS/canonical retries and bounded stale-response fencing. No pending-action counters,
notifications or durable offline/native promises. Source-grounded Tan Ata words mode,
not closure of all11 conversation modes. Early review and exact FULL11 gates pending.
See [LOVE_WORDS](LOVE_WORDS.md).

### Ask me candidate after accepted e469600
Authored shared question, one recipient answer or voluntary terminal skip; independent
own-text removal preserves the other's words and consent state. Complete bounded100
lifetime history, CAS/canonical retries and honest RAM drafts. Not blind answers,
notifications or production readiness. See [ASK_ME](ASK_ME.md); early/full gates pending.

### Voluntary day scale candidate after accepted5d93a70
Explicit own0–100 day rating shared with partner, correction/removal and deliberate
new publication; missing is not0 and no default50 is sent. Stable local date/IANA,
new entry only for trusted today with midnight mismatch rejection; no diagnosis,
comparison/ranking or reminders. Complete bounded100 lifetime dates per author.
See [DAY_SCALE](DAY_SCALE.md). Early review and exact FULL11 acceptance pending.

### Continue the phrase candidate after accepted6547291
Authored beginning plus committed hidden own continuation; other participant may
complete once and reveal both, or voluntarily skip without disclosure. Own bundle
and recipient response removal preserve the other author's text and completed
state. Not a replacement for existing fixed blind rounds. Bounded synthetic100
lifetime history, no provider/native claims. See [CONTINUE_PHRASE](CONTINUE_PHRASE.md).

### Verification diagnostics before further P1
Private per-step raw output evidence closes the observability gap from unexplained
mobile failures. Bounded streamed files, full digests, explicit incomplete status;
no command/test/timeout changes. Earlier failures retained, not declared fixed.
Separate reviewed exact-SHA author/independent FULL gates required. See
[VERIFICATION_LOG_RETENTION](VERIFICATION_LOG_RETENTION.md).

### Ordered stories candidate after accepted316978a
Short authored topic and one voluntary long narrative, with no deadline or reminder.
Metadata-only complete synthetic100 history/ACK and explicit body reader distinguish
this from Ask's inline2000-character responses. Own topic/body removal preserves the
other author's part; CAS/current retries, epoch ACL and RAM drafts remain bounded.
Independent contract review and focused API/mobile passed; real PG/HTTP/mobile and
both exact clean FULL11 gates remain required. No native/production claim; accepted
Library v17 is unchanged. See [ORDERED_STORIES](ORDERED_STORIES.md).

### Hard question candidate after accepted67c6607
Authored question is hidden from its recipient until a voluntary, confirmed opening;
the author can read their own text. One opening transition, repeated later reads,
explicit decline without revealing and own-author removal preserve recipient choice.
Distinct from Ask/Stories/Blind; no answer obligation/deadline/provider. Bounded
synthetic2000-character/100-envelope history, epoch ACL/CAS/current retries and RAM
display generations. Early reviews/focused passed, realPG and both exact FULLs pending.
See [HARD_QUESTIONS](HARD_QUESTIONS.md); accepted18/storiesWIP4 remain unchanged.
## Shared doings after acceptedafd0770 — synthetic checkpoint

Two separate personal positions through one book/course/series; automatic current
completion only when both reach the end. Explicit recipient join/refusal, own-only
advance and withdrawal, author removal of shared title/total/BOTH positions.
Bounded100 history/title200/parts1000, independent default-off loopback flag, RAM
draft/pending, strict CAS/current retry. No deadline, reminders or participation by
silence. See [SHARED_DOINGS](SHARED_DOINGS.md) for source facts vs adaptations.
Early semantic/API review passed; mobile replay P2 reproduced and fixed with applied
operation reachability. Focused API12/mobile29 passed; all failed evidence retained.
Dedicated realPG/HTTP/mobile cases are added but not yet executed at this checkpoint.
Exact author and independent FULL still required. Separate WIP; accepted19 unchanged.
Native iOS/Android, two-device E2E, durable offline and production remain open.

