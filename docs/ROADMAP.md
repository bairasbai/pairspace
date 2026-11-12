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
