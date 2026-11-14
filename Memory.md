# Память проекта: решения и доказательства

Это версионируемая техническая память проекта, не хранилище личной переписки пользователей.

## 2026-11-10 — восстановленный пакет
- Фактически проверенный main: ccbe5dfe013b29aee3ddfdcffd1705d51f3de4a2.
- Сохранены веб-концепт Kimi и нейтральное ядро предыдущего 537601e.
- npm test: 9/9 на Node 24.22.1 в облаке. Node 22 отдельно не проверялся в этой проверке.
- Этот коммит документационный. Приложение, backend, Expo и coverage-gate он не реализует.
- Ранее сообщалось о неопубликованном Expo-прототипе и 21 документе; их рабочие файлы в текущем облаке не найдены.
- Поэтому прежние 68 Jest/8 tooling и 100% маленького среза здесь не считаются подтверждёнными результатами.
- Данный пакет создан заново по доступному GitHub, требованиям владельца и сохранившемуся исследованию.

## Принято владельцем
Expo; русский/английский; читаемые модули; ≤600 строк; тесты ≥90%; независимая приёмка.
Tan Ata и исследование — основа продукта; центральное сердце «Думаю о тебе» с пульсацией.
Приватный чат для постоянного общения; облачная разработка и GitHub для истории проекта.
Amio только рабочее имя. Production Tan Ata не трогать.

## Формат будущей записи
Дата, задача, SHA, что работает, что только запланировано, проверки и ограничения,
решения/ссылки, следующий шаг. Не записывать секреты, личные сообщения и токены.

## 2026-11-10 — новый мобильный preview
Создан заново в отдельной облачной ветке поверх опубликованного docs c1a3202.
Expo 58.0.23, RN 0.88.1, React 19.3.0. RU/EN, навигация, сердце с reduced motion,
пробный RAM-черновик без отправки. Отсутствует backend, auth, хранение и реальная переписка.
Lint/typecheck, 9 мобильных Jest (8 runtime-файлов, 100% четырёх метрик) и 9 исходных domain-тестов проходят.
Hermes export обеих ОС не заменяет native build. Native запуск и визуальная приёмка не выполнены.
Audit после безопасных обновлений: 1 low, 42 moderate (независимый повторный снимок); не применять несовместимый force-downgrade.
Независимая приёмка и публикация кода пока не выполнены; main Kimi не менялся.

## 2026-11-10 — локальное ядро чата
Добавлен dependency-free immutable outgoing reducer: NFC/8000 codepoints, scoped session/epoch,
идемпотентность, retry/ACK, tombstone replay, pause и очистка при revoke/logout/login.
49 новых core-кейсов, 58 mobile tests; 100% runtime coverage четырёх метрик этого мобильного среза.
Это не авторизация: scope задаётся доверенным кодом приложения; сервер и транспорт ещё отсутствуют.
UI не подключён; receipts/history/хранение/шифрование не реализованы. Независимая приёмка ожидается.

## 2026-11-10 — SQL-backed chat use cases
Созданы services/api и PostgreSQL migration: scoped send/idempotency/history, transactional outbox,
закрытие пары без удаления архива, composite FK и проверка двух участников. PGlite test-only.
Нормализация одна в packages/domain; NUL теперь отклоняется совместно mobile/API.
38 SQL/use-case тестов, включая rollback и reopen; 59 mobile + 9 root tests, typecheck/lint проходят.
Проверки нескольких PostgreSQL-сессий, auth/HTTP, native и E2EE отсутствуют. Не подключено к UI.
API tooling audit — динамический снимок 2026-11-10: reviewer 11 moderate; повтор 05:54 UTC — 10 moderate, 0 high/critical. Runtime npm dependencies отсутствуют.
Lock-контракт уточнён: сначала couple FOR UPDATE/SHARE, затем отдельный SELECT membership с новым READ COMMITTED snapshot; реальная multi-session гонка пока не проверена.
Независимая приёмка нового коммита ожидается; публикации и production изменений нет.

## 2026-11-10 — HTTP/client transport prototype
Добавлены GET/POST /v1/couples/{id}/chat/messages с обязательным injected SessionVerifier;
реальных login/provider/session management нет, synthetic tokens существуют только в тестах.
Client adapter связывает очередь с in-process handler и SQL в тестах; UI не подключён.
Проверяются потерянный ACK/retry, четыре аккаунта/две пары, поздний ответ после смены сессии,
отзыв/закрытие, конфликт ID, malformed/bounded JSON и скрытие внутренних ошибок.
Response DTO и beforeSeq пока внутренние, не полный v1. Нет listener/deploy/production данных.
Проверки: 44 API tests (100% lines/functions/statements, 99.26% branches),
148 mobile tests (100% lines/functions/statements, 98.81% branches), 9 root tests.
Lint/typecheck и Hermes export проходят; native/real network/multi-session PostgreSQL не проверены.
Зависимости не добавлялись. Независимая приёмка нового SHA ожидается; публикации нет.

### Исправление после независимого review transport
Предыдущий transport ошибочно очищал очередь при opaque401/403; та ревизия не принята.
Теперь 401 pause/auth_required и 403 pause/access_required сохраняют весь текст и clientId.
Отправка и чтение ждут доверенной revalidation; только explicit revoke/logout очищает.
Credential generation отдельно от scope: старый ответ после refresh не меняет новую отправку.
HTTPS default; HTTP только явный loopback test opt-in. 429 queued/rate_limited без автоповтора; 405 Allow.
Повторные проверки: 45 API tests, coverage 100/99.27/100/100; 184 mobile tests,
coverage 100/99.43/100/100; root 9 tests. Typecheck/lint и Hermes export проходят.
Повторная независимая приёмка ожидается; production, native и multi-session PostgreSQL не проверены.

## 2026-11-10 — signed-token/session prototype
jose6.2.17 MIT проверяет ES256/at+jwt по injected public key, issuer/audience/time/sub/sid;
никаких provider/network/JWKS/login/issuance, ключи только ephemeral в тестах.
SQL migration002: identity→user mapping, sessions/expiry/revoked_at, deleted_at пользователя.
Каждый send/history/close повторно проверяет user+session с locks до couple: нельзя обойти отзыв
между signature verification и SQL write. Clock обязателен, invalid clock закрывает доступ.
Тесты включают реальную подпись, tamper/alg/key/aud/iss/time, four users/two pairs, revoke/expiry gap.
Expiry — snapshot после session lock; уже авторизованные транзакции не отменяются мгновенно.
Runtime audit0; общий10moderate tooling на 2026-11-10, снимок динамический.
Нет native/real-provider/multi-session concurrency проверки; независимая приёмка ожидается.
Проверки: API64 tests, coverage statements99.52/branches99.08/functions100/lines99.35;
mobile184 tests 100/99.43/100/100; root9 tests. Typecheck/lint проходят.

### Auth review correction
JWT iat — целые секунды, SQL created_at — дробные: исправлено сравнение floor(epoch created_at)<=iat
с отдельной проверкой created_at<=trusted now. Regression: .500 valid при now.750, invalid при now.250.
Audit review2026-11-10: runtime0/tooling11moderate против авторского10; динамические снимки.
Повтор: API65 tests (99.52/99.08/100/99.35), mobile184 (100/99.43/100/100), root9;
typecheck/lint проходят. Повторная независимая приёмка ожидается; публикации нет.

## UI preview checkpoint, 10 November 2026
Implemented the first bounded visual step from the approved six-screen concept:
Today cards, sample letter, calendar plans/tasks toggle, memories and the Together
catalogue (questions, wishes, dates, checkers, battleship, support, films).
These are explicitly labelled demonstration surfaces, not completed product features.
Existing central heart, Reduce Motion and in-memory chat draft are preserved.
Nested navigation resets when changing primary tabs; draft stays in App memory.
Source was restored from verified b16af21 ZIP; no unrelated branch/files were edited.

## Subscription domain checkpoint, 10 November 2026
Pure policy added for the approved 299 RUB/month or 2490 RUB/year for two people.
Chat, history and security never depend on paid eligibility; existing ACL remains.
Exact server-time boundaries and same-pair matching are enforced without transfer.
Billing integration and breakup/ownership policies remain separate future work.
Acceptance awaits independent review; no publication or deployment in this change.

## Уточнение карты Tan Ata, 10 ноября 2026
Карта docs/TAN_ATA_MAP.md дополнена пропущенными сценариями и 11 точными режимами.
Сердце мобильного preview вызывает только alert; живые сценарии не перенесены.
На момент инвентаризации решение об астрологии/нумерологии ожидалось; последующее
решение ниже заменяет это ограничение. Эта запись относится к документальной правке.

## Полный перенос Tan Ata, 10 ноября 2026
Владелец включил все функции Tan Ata в план нового приложения с возможными улучшениями.
Астрология/нумерология теперь План P2, не исключение; добровольное развлечение,
без научных/диагностических обещаний, минимальный ввод, согласие и изоляция пар.
Новые идеи вне Tan Ata и распределение Free/Plus остаются отдельными решениями.
Изменены только документы поверх опубликованного 5b92c833b4d80a5f372a67e0675ff70969340ea6;
текущая готовность не повышена. Независимая приёмка этой новой правки ожидается.

## Kimi styling alignment
See [KIMI_DESIGN_ALIGNMENT](docs/KIMI_DESIGN_ALIGNMENT.md): bounded mobile palette/typography/navigation styling.
Device visual acceptance remains open; no backend features added.

## 2026-11-10 — мобильные синтетические приглашения, приёмка ожидается
Поверх API 0814b0f реализован opt-in UI владельца и получателя, RAM-only токены,
точный retry принятия после lost ACK и очистка при смене сеанса/контекста.
Kimi/default network-off сохранены. Внешней доставки, clipboard API, production и native
приёмки нет. Токен владельца не выделяется для копирования системным меню.
Контракт и ограничения: apps/mobile/PAIR_INVITATIONS.md; результаты: evidence/invitations/.
Не считать выполнением production onboarding или независимой приёмкой.

## 2026-11-10 — синтетический chat recovery, приёмка ожидается
Compose → transient failure → explicit retry хранит одну неизменяемую команду отдельно
от редактируемого черновика. Lost ACK повторяется с прежним ID/body; A→B→A не стирается.
Transient discovery сохраняет RAM только для ранее проверенной session; auth/scope
смена/logout/unmount очищают private state. ACK означает принятие сервером, не чтение.
Реальный disposable PostgreSQL fixture проверяет одну message/outbox при replay.
Контракт: apps/mobile/CHAT_RECOVERY.md. Без persistence/autoretry/production/native build.

## Draft lifecycle experiment
Added opt-in synthetic bounded draft coordinator, not real storage or product UX.
Verified-context gate, user/couple/epoch/origin binding, normalized 2KiB envelope,
serialized purge and terminal consume-before-send tested with injected storage.
Unknown ACK restart harness uses real queue/transport and never creates a new send.
Do not ship before durable logout/install policy, native/device checks and controller
integration. Real application drafts remain in memory. See chat/DRAFT_CONTRACT.md.

## 2026-11-10 — старые сообщения в синтетическом чате
Добавлен явный RU/EN Load older с загрузкой/ошибкой/retry/началом истории и лимитом
200 сообщений. Каждый запрос повторно проверяет cookie/session/account/pair/epoch.
Refresh намеренно сбрасывает окно к последним 50 и сообщает об этом, чтобы не скрыть
разрыв при появлении >50 новых сообщений. Черновик и unresolved outgoing сохранены.
Реальный PostgreSQL выявил сортировку seq::text по alias; исправлена сортировка
по числовому chat_messages.seq. Доказательства и ограничения: apps/mobile/CHAT_HISTORY.md и evidence/chat-history.
Статус: локально реализовано, независимая приёмка ожидается; native не проверен.

## 2026-11-10 — synthetic «Думаю о тебе»
Отдельный фиксированный сигнал не заменяет чат. Партнёр явно запрашивает последний
входящий сигнал; нет push, presence, местоположения, delivery или read receipts.
60 секунд — продуктовый cooldown, не доказательство защиты от злоупотреблений.
24 часа — окно видимости, не срок удаления: минимальный журнал команд пока хранится
для дедупликации. Повтор проверяет текущие session, membership и epoch до lookup.
Исходный offline App остаётся честным демо; native/device и production gates открыты.
Локально проверено: API181/mobile989/realPG94 pass, coverage всех четырёх метрик ≥90%.
Статус: независимая приёмка финального SHA отдельно.

## 2026-11-10 — центральное сердце, explicit synthetic only
App использует существующий care controller на всех вкладках только при явно
переданном synthetic controller. Одно центральное пульсирующее сердце; подключённая
панель сохраняет явное чтение входящего сигнала. Обычный App остаётся offline demo.
Unknown-ACK повтор сохраняет ID между вкладками; logout, замена controller и unmount
очищают состояние. Нативная приёмка не выполнена. Статус: независимая приёмка ожидается.
Проверки: [CENTRAL_HEART_EVIDENCE](docs/CENTRAL_HEART_EVIDENCE.md).

## 2026-11-10 — ограниченный путь писем, synthetic only
Черновик существует только в RAM автора. Отправить сейчас создаёт неизменяемую
команду; повтор неизвестного ACK сохраняет ID и текст. Входящий список партнёра
содержит только метаданные последних 30 писем, тело открывается отдельным запросом.
Каждое действие проверяет SQL-сессию, двух активных участников и epoch; новая пара
не наследует старое письмо или ключ отправки. Подтверждение означает доступность
на сервере, не доставку на устройство и не прочтение. Нет scheduled/sealed, ответов,
правок/удаления, push, AI или долговечного черновика. Это не полная функция писем
Tan Ata и не разрешение реальных личных данных. См. docs/LETTERS_EVIDENCE.md.

## 2026-11-10 — scheduled letters, synthetic only, не принято
Следующий ограниченный шаг добавляет явную отправку на будущее и серверное открытие
по неизменяемому instant + IANA timezone. Ввод требует явного ISO offset: DST gap
отвергается, повтор часа выбирается offset, часы клиента не открывают письмо.
Продуктовое synthetic-окно: 60 секунд–366 суток; старые письма остаются немедленными.
Unknown ACK сохраняет исходные body и schedule; refresh метаданных и открытие явные.
Это серверный plaintext, не E2EE; нет push/jobs/read receipts. Независимая приёмка,
native/two-device и production gates открыты. См. docs/SCHEDULED_LETTERS_EVIDENCE.md.

## 2026-11-10 — добровольное завершение активной synthetic-пары
Участник закрывает пару без согласия партнёра. Оба членства и неиспользованные
приглашения отзываются, epoch увеличивается; chat/care/letters, включая scheduled,
больше не доступны обычным API. Записи сохраняются, автоматического создания пары нет.
Подтверждение неизменно связано со старой pair/epoch/command; повтор неизвестного ACK
возвращает только проверенный исход старой пары и не меняет новую. Provider login
сохраняется; приватный RAM-контент очищается при подтверждённой отправке команды.
Это synthetic-предложение, не утверждение production-политики архива/удаления.
Native/device, E2EE, production и owner ADR остаются открытыми. Независимая приёмка
точного SHA отдельно; см. docs/PAIR_LEAVE_EVIDENCE.md.

## 2026-11-10 — общие задачи, ограниченный synthetic-срез
Оба активных участника могут явно создать общую задачу, выполнить или открыть её
снова. Список ограничен последними 50 по времени создания; это не весь архив.
Версия защищает от одновременной перезаписи; конфликт требует явного обновления.
Неизвестный ACK повторяет исходную команду, не новый текст черновика. Replay
возвращает текущее состояние и исходную appliedVersion, не обещает старый результат.
Закрытая пара недоступна; новая пара не наследует задачи или отложенные команды.
Нет назначения, сроков, правки, удаления, push, production или решений об архиве.
Default Kimi остаётся offline; тексты приватны, хранятся сервером без E2EE.
Авторские проверки: API211/mobile1203/realPG144 прошли, четыре метрики coverage≥90%.
Независимая приёмка точного SHA и native/device QA отдельно. См. docs/SHARED_TASKS_EVIDENCE.md.

## 2026-11-10 — слепые ответы, первый ограниченный раунд
На базе tree 565e76a5ce38d6993ca2682eeb8ffdd12f6d34c4 начат независимый synthetic-срез.
Один встроенный нейтральный RU/EN вопрос v1; один раунд на pair/epoch.
Это ограничение текущей реализации, не решение о production-квотах.
Ответ нельзя изменить после явного подтверждения; до этого черновик только RAM.
Чужой текст и даже признак отправки скрыты до двух submissions. Свой отправленный
ответ доступен после перезагрузки при свежей авторизации. Сервер читает plaintext.
Нет AI, психологических оценок, уведомлений, ежедневного scheduler или архива.
Статус до независимой проверки: не принято. Подробности в BLIND_ANSWERS_EVIDENCE.

## 2026-11-10 — повторяемые synthetic-раунды, не принято
Продолжение на tree 18ac4fb978b1edd3031cc7a777d529a82536595a. Ограничение
единственного раунда из предыдущей записи заменено явной цепочкой: следующий
только после двух подтверждённых ответов текущего. Старый small-joy v1 сохранён,
добавлены два нейтральных вопроса RU/EN без психологических обещаний.
История показывает metadata последних десяти, выбранное тело читается отдельно.
Legacy open/read не создают следующий раунд; replay привязан к исходному target.
Draft/consent не переходят между вопросами, immutable pending retry сохраняет
исходный раунд/команду. Нет автосмены, правок/удаления, production или новой политики
архива после выхода. Проверки и ограничения: docs/BLIND_ROUNDS_EVIDENCE.md.

## 2026-11-10 — общие однократные даты, не принято
Продолжение на tree 19229f4517f10c6324178830d476b5880efab444. Явное создание
любым активным участником делает запись общей для обоих, это не приглашение
на свидание и не согласование встречи. YYYY-MM-DD остаётся календарной строкой,
IANA-пояс служит ссылкой для отображения, не превращает дату в полночь UTC.
Последние 50 по созданию, не ближайшие 50 и не полный архив. Нет отсчёта,
повторений, ежегодных дней рождения, edit/delete, напоминаний или календарного sync.
Черновик только RAM; неизвестный ACK удерживает неизменяемую исходную команду.
Default Kimi/offline и существующая политика закрытия пары сохранены.
Проверки и ограничения: docs/SHARED_DATES_EVIDENCE.md. Native/device/production открыты.

## 2026-11-10: ежегодные общие даты
Продолжен bounded synthetic-срез поверх tree c902e859df60f1f83d55dd668a47af8753922fb2.
Additive once/annual, явная политика 29 февраля, immutable retry schedule и exact
IANA. Следующая дата зависит от серверного zoned today после fresh auth/locks;
ручной refresh не scheduler и не напоминание. Старые create/строки совместимы.
Приёмка автора и независимый review разделены, native и два устройства не
подтверждены. Доказательства и границы: docs/ANNUAL_DATES_EVIDENCE.md.

Первый annual freeze 0b0d0a9 не прошёл независимый mobile typecheck (TS5097).
False PASS возник из masked shell exit; сохранён failed log и исправлен noEmit
tsconfig для .ts imports. Приёмка требует отдельных exit codes и просмотра
завершённых logs, а не только успешной последней команды.

## 2026-11-10 — fail-closed локальная проверка
Добавлен отдельный engineering checkpoint, а не продуктовая функция. Не допускает
маскировку ошибки tsc успешной последующей командой. Каждому запуску соответствует
уникальный report с точным source SHA/tree/hash и отдельным статусом каждого шага.
Подробности и ограничения: docs/VERIFICATION_RUNNER.md. Предварительные тесты
runner пройдены; full checkpoint и независимая приёмка требуют frozen SHA/report.

## 2026-11-10 — редактирование общей даты
Продолжен synthetic connected сценарий: название, календарная дата, IANA пояс,
повторение и явная политика 29 февраля. Optimistic version не допускает тихой
перезаписи партнёра; исторический retry возвращает актуальную запись.
Default App остаётся demo, production/deploy/push не входят в этот срез.
Нет reminders/E2EE и решения об архиве после расставания. Приёмка отдельно
от реализации: docs/DATE_EDITING_EVIDENCE.md.

## 2026-11-11 — общие текстовые воспоминания, кандидат
Начат bounded synthetic-срез общей хроники: заголовок, текст и календарный день,
явная публикация для обоих, неизменяемая команда и последние 50 записей.
Исходная карта различает хронику `/talk/moments` и дневник `/us`; этот срез
не закрывает перенос дневника ответов обоих и не меняет правила слепого раскрытия.
RAM-черновик приватен до подтверждения; серверное содержимое plaintext, не E2EE.
Никаких автоматических записей, AI, tracking, удаления или решения об архиве.
Точный frozen SHA, full gate и независимая приёмка фиксируются отдельно.
См. docs/SHARED_MEMORIES.md и docs/SHARED_MEMORIES_EVIDENCE.md.

## 2026-11-11 — наши песни с объяснениями
Поверх локального 9b8bd83 добавлен отдельный synthetic-срез title + explanation
с подтверждением видимости партнёру, immutable retry и bounded latest50.
Данные песен не смешиваются с memories; черновики только RAM. Сервер plaintext.
Внешние ссылки сознательно оставлены следующему срезу вместе с editing/order:
нет URL-поля, автозагрузки preview, плеера, lyrics или копирования плейлиста.
Тесты охватывают actual mobile→HTTP→PG lostACK, изоляцию и lifecycle; фактический
результат all-eleven gate привязан к frozen SHA во внешнем report.
Статус: кандидат, независимая приёмка ожидается; не весь Tan Ata и не native-ready.
Контракт/границы: [SHARED_SONGS](docs/SHARED_SONGS.md).

## 2026-11-11 — bounded song-link candidate
Добавлена необязательная музыкальная ссылка с пятью точными HTTPS хостами,
без query/fragment/URI схем, сетевых запросов и новых зависимостей.
Явная кнопка передаёт URL Linking.openURL после видимого предупреждения;
не гарантирует содержимое, редиректы или права. Старые no-link receipts совместимы.
Полный frozen checkpoint и независимая приёмка обязательны; native, two-device,
legacy Next и production readiness не подтверждены.

## 2026-11-11 — запас времени PostgreSQL checkpoint
Диагностический baseline 215/215 PASS занял 239.744s при guard 240s.
Четыре независимых official signup в общем letters fixture стали bounded parallel;
allSettled завершает все запросы до cleanup, порядок identities сохраняется.
Production auth/миграции/clock/guards неизменны; schema, cookies и state не reuse.
Focused lifecycle 2/2 PASS после исправления ошибочной проверки separate authority.
Полный frozen gate и независимая приёмка отдельно; см. POSTGRES_VERIFICATION_RELIABILITY.

## 2026-11-11 — исправление своей песни, кандидат
Продолжен перенос сценария песен Tan Ata: автор может явно исправить название,
объяснение и ссылку. Партнёр не редактирует чужое объяснение. Version CAS
защищает новые изменения; immutable receipts сохраняют старый create/retry.
Неизвестный ACK не теряет новый черновик; refresh не перезаписывает ввод.
Сервер plaintext, latest50, synthetic loopback и default demo сохранены.
Не реализованы удаление/undo/history/ручной порядок. Frozen gate и независимая
приёмка отдельно: docs/SONG_EDITING_EVIDENCE.md. Native/two-device NOT_RUN.

## 2026-11-11 — желания, отдельный synthetic-кандидат
Продолжен P1 перенос Tan Ata: название и необязательное короткое пояснение,
явное согласие на публикацию обоим, immutable создание и сохранённый автор.
Оба активных партнёра явно меняют только fulfilled/open через version CAS.
Отдельная коллекция, не задачи; no links/purchases/assignment/notifications.
Unknown ACK повторяет исходную команду с canonical current state, новый RAM
черновик сохраняется. Closed-pair policy и default demo неизменны.
Полный frozen gate и независимая приёмка отдельно; сервер plaintext,
native/two-device NOT_RUN. Контракт: docs/SHARED_WISHES.md.

### New work after cloud reset

Public5a998162 already contains connected chat/authentication/recovery; do not duplicate that functionality or claim later lost commits were restored. The selected substantive gap is history beyond200 messages. New50-message server windows retain exact scoped ID+seq anchors, pending commands and drafts, with explicit Latest after send rather than surprising navigation. Existing queue500 limit remains. Initial dependency install retried only with a writable cache, exact lockfiles unchanged; production/native gates remain open.

## New chat reply stage after accepted 9c64e64
Implement canonical message references, not persisted private quote copies. Explicit detail
must reach a source outside the current 50-message window. Unknown sends retain their
original target; a late ACK must preserve newer text/selection. Internal tombstone tests
are deliberately not a user-facing deletion feature. Prior accepted sources stay intact.

## Own-message deletion stage
Deletion is explicit and terminal for both current participants, not physical row removal.
Cancel is meaningful only before DELETE dispatch; unknown results retain an exact command.
A confirmation captures ID/version/session, never follows a changed selection. Server
receipts retain no body; canonical tombstones reuse observed-deletion barriers and preserve
unrelated drafts. No realtime update or account-retention purge is implied.

## Own-message editing stage
Accepted deletion checkpoint f6197f8 is preserved in its own checkout and archives.
Editing must never compare an original send command with a mutable current body.
An immutable original digest plus immutable identity protects retries; receipts store
hashes rather than historical plaintext. Hashes are not encryption. Version 1 ACKs
retain exact body matching; edited replays require exact immutable identity and return
current content only. Tombstones dominate all subsequent live ACKs. A separate edit
form protects unsaved text on conflict and requires explicit save; unknown outcomes
retain one original command. No realtime or durable offline draft claim.

Owner clarification after author997c12b: an unchanged normalized save must not create
an Edited label. New no-op receipt records applied_version/intent without updating
message version. Actual edits and restoration of original text remain marked. Stored
or delivered notifications are not automatically rewritten. 997c12b is preserved as
an author-tested but superseded candidate, not independently accepted.

## Personal hide/restore stage
Hiding is not deletion. It must affect all canonical read/replay paths for one actor
without exposing the fact to the partner. A global actor+pair+epoch revision fences
old in-flight body responses; a per-message version protects toggle commands. Capture
revision inside the same locked transaction as the projection, never after commit.
Exact committed hidden retries resolve with metadata, not historical body and not a
fake tombstone. Restoration must read current edited content or terminal deletion.

Visibility author focused evidence: API63, mobile1940, actualPG51 PASS. Root's
whole-hidden-page criterion proved with251 synthetic rows, boundary+middle50 hidden,
full traversal/restoration and unchanged partner. No production/publication. Frozen
FULL11 and independent acceptance pending; do not treat focused PASS as acceptance.

Next approved slice from accepted1d993: remove500-success outgoing hard-stop through
terminal-only compaction; explicit local discard with unknown-outcome warning and
operation/session guards. Current-session security denial still wins after discard.
No server cancellation, publication, durable queue or realtime claim. Acceptance pending.

Outgoing focused evidence: mobile1967/1967 and actualPG61/61 PASS, including501 real
successful sends, old-operation/current-session denial distinction and retained
reply/edit/delete/visibility regressions. API production unchanged. Await frozen
FULL11 and independent acceptance; do not treat focused PASS as accepted checkpoint.

Next approved slice from18053d5: experimental encrypted composer+onepending journal,
online membership before reveal, explicit restore/retry, no autoPOST. Restored pending
always metadata-only; canonical server response alone permits message display. Native
backup/reinstall/power-loss proof remains open. No production/publication. See CHAT_JOURNAL.

- Next candidate after independently accepted experimental journal ab81: bounded current-window
  reconciliation, explicit/foreground only, no polling or autoPOST. Preserve old history position,
  drafts and terminal knowledge; journal remains default-off. Exact gates pending.

- Next candidate after accepted2db3d05: explicit morning ritual, own recipient preferences,
  immutable assigned slots, one-time fill and bounded complete history. Original code audited,
  no original letters copied. No late fill/edit/cancel/period links; not full parity. Gates pending.

- Morning `ab3de3e` accepted independently in local synthetic scope (FULL11 +10 extras).
  Next independent candidate adds replies under each morning letter, without copying
  the letter into chat or exposing recipient opening status. Sender release and recipient
  durable latch remain distinct ACLs. Own reply edit/delete are deferred explicitly;
  new work needs author FULL11 and independent acceptance. Journal remains default-off.

- Morning discussions5343ce5 accepted independently FULL11+11 extras. Next candidate
  adds own CAS edit/no-op and terminal delete via v2; original create fingerprints remain
  immutable, no historical body copies. Legacy deleted paths fail closed. Journal stays
  default-off; native and publication not claimed. All prior sources/artifacts retained.

- c276fcc morning reply mutations accepted independently in synthetic/cloud scope.
  Next candidate: prepared morning author-only edit before release, separate GET/PUT,
  CAS/no-op and immutable fingerprints. Never gate edits on recipient opening (read
  receipt leak); require trusted application time and SQL wall clock before release.
  Real rollback of both clocks is outside proof. Original fill API remains unchanged.
  Separate RAM editor preserves newer drafts/unknown commands. Gates pending.

- Prepared editing4d4ef80 independently accepted FULL11+12+7 external checks in cloud.
  Next bounded P0 candidate: explicit private morning drafts save/load, not automatic
  readiness. Server plaintext+ACL, no E2EE claim. Draft may survive deadline/fill without
  becoming recipient content. Server deletion/retention remain separate policy work;
  current active membership required. Exact author and independent gates pending.

- Private morning draft53a1734 independently accepted FULL11+16 extras. Next candidate
  author-confirmed logical removal: current body cleared, terminal version retained;
  no restore/recreate for that slot in this slice. Prepared letters unaffected, no
  physical backup purge promise. V2 canonical replay, legacy failclosed, terminal
  knowledge survives form close. Exact author/independent gates pending.

- Terminal morning draft removal710a124 independently accepted: author and independent
  FULL11 11/11 each plus10 adversarial PG checks; prior interrupted report not accepted.
  New P0 separation-period slice follows TAN_ATA_MAP, separate from shared dates.
  Explicit create/list/edit inclusive local ranges+IANA, stable identity and overlap
  guards; server checked-at countdown rather than deviceclock promise. Existing morning
  slots/letters unchanged, no linkage/renumbering/flight/notifications. Candidate gates pending.

- Separation periods a0cb439 independently accepted: author repeat and independent
  FULL11 11/11 each; prior Metro dependency symlink failure preserved, not accepted.
  Next bounded P0: independent manual arrival plan, source grounded in Tan Ata
  MoveArrival but no gender/penalty/only-later restriction. No booking/airline status,
  period or letter changes. Optional label, explicit IANA+offset, CAS/current retry.
  Candidate pending exact author and independent FULL11; no native/production claim.

- Manual arrival2c706114 is independently accepted. Next bounded P0 is actor-private
  saved rules for future notifications, default off, generic-only and optional quiet
  interval. Own-rule preview simulation accepts category only at server now, not an
  event or delivery request. Existing sends are unchanged; no token/provider/job/OS
  permission. First save0→1, later no-op stable version; exact gates pending.

## Care capture / notification simulation
Approved bounded next slice: new care signal produces atomic outbox; existing sends/replays
retain their contract. Internal dry-run observes current membership and recipient policy,
never sends. Replays are historical evidence, not current authorization. Quiet hours do not
schedule later delivery. Session/device delivery checks remain future work. See CARE_OUTBOX.
Independent review W1 caught stale worker time sampled before a membership-lock wait.
Clock is now sampled after the final lock, shared by policy, observation and processed_at;
actual blocked-row regressions cover expiry and quiet-start boundaries. Old run preserved.

## Chat notification privacy
Approved next slice reuses existing chat.message_created event, captures originating scope in
atomic sidecar without historical backfill, and evaluates current source metadata/recipient
visibility/preferences internally. Senderhide and replyparent do not drive recipient rules.
No shared processed_at mutation; replay is historical evidence. Clock after final locks/reads.
Early self/independent review identified capture recipient-lock authority expiry risk. Producers
must recheck after capture and throw exact rollback sentinel, mapped outside transaction;
returning unavailable inside transaction would wrongly commit. Real expiry regressions added.
API coverage outer budget reviewed: dd00c51 author234968ms, independent diagnostic233806ms
left only~2–2.6% reserve under240s after an independent timeout. Approved bounded300s outer
reserve, unchanged fulltests/includes/90% thresholds/pertest30s. Old failure remains preserved;
new source needs author and independentFULL anew. See VERIFICATION_RUNNER.md.

## Morning-letter notification boundary
Approved ONLYmorning_slots, not legacyletters. Before actualSQLrelease uniformnot_due with no
content/prefs/draft/opening/observation query/write. One SQLtime afteralllocks shared gate/policy/asOf.
Afterrelease contentEXISTS only, missedblocked, availablelatestletterprefs; no autoopen/readstate.
Historicalreplay stays internal evidence, not deliverygrant. Earlyreview required beforefreeze.
Morning early review hardened release at SQL level: one materialized timestamp +releasedboolean,
contentEXISTS gated bysameexact timestamp, microsecondasOf preserved. First sharedboundary test
exposed testpool starvation; notificationlockcases now use isolated bounded connections, old
prepared pool/assertions unchanged. Failures preserved, no budgetincrease.

## Love dictionary candidate after accepted1a415a0
Read Tan Ata words page, WordForm and lib/talk on4822e213. Word required, meaning and
occasion optional; author-only editing, visible author and glossary presentation.
Build independent pair/epoch-scoped user flow instead of more delivery simulations.
Confirmed own deletion is a privacy improvement. Synthetic100 lifetime INCLUDING
removed entries is explicit in UI, not a tariff; edits/deletions remain available.
Full reads alone establish snapshot checkedAt; own canonical ACK only updates its
entry. Metadata tombstones and version fences prevent late-list resurrection. No
private original data, provider/native delivery, persistence or production claims.
Early independent review and exact author/independent FULL11 pending; no GitHub/main.

## Observed PostgreSQL boundary fixture repair during dictionary verification
The first frozen dictionary FULL timed out; unchanged raw PG diagnosis also exposed
an earlier assertion failure. Holder-transaction pg_stat_activity was cached while
pg_blocking_pids was live, pairing old query text with a new real blocker. Dedicated
real-PG regression reproduced this and the pg_stat_clear_snapshot remedy. Refresh
stats before each poll; retain exact SQL/blocker/pre-release assertions. Await both
parallel holder cleanups before propagating failure. Production code unchanged;
prior FAIL retained. Re-freeze/full gates required, larger diagnostic is not acceptance.

## Bounded aggregate PG reserve
After observer repair, diagnostic-only407/407 completed in948s, not acceptance.
Approved wrapper1110s/runner1140s from15% measured reserve rounded30s, keeping30s
cleanup margin,15s runner grace,10s kill grace and all inner/test/SQL settings.
Observer explains stale-query assertions, not unknown aggregate runtime slowdown.
Exact profile regression/docs and new frozen author+independent FULL required.

## Independent API measurement reserve after b4017a1
Independent API300s timeout repeated after cloud recovery. Diagnostic-only600s run
completed388tests/64files in353535ms, coverage99.10/97.32/100/99.53; not acceptance.
Approved outer API450s (25% reserve rounded30s), exact args/coverage/inner guards and
all other budgets unchanged. Aggregate slowdown cause unknown. New SHA/both FULLs
required; earlier authorPASS applies only to b4017a1, independent not yet accepted.

## Ask me candidate after accepted e469600
Tan Ata ask page/AskBoard/libtalk confirmed single recipient answer and sharedhistory.
New bounded user slice adds voluntary terminal skip and split own-text removal:
asker never erases other's answer; answering actor can remove own answer only.
Question removal after skip preserves recipient choice; withdrawal is distinct.
Explicit confirmations explain remaining text, terminal choices and no replacement.
100 lifetime synthetic cap, CAS/current retries, RAM drafts, no provider/native claims.
Early independent review and both FULLs pending. Source branch only, no GitHub/main.

## Day scale candidate after accepted5d93a70
Tan Ata scale page/ScaleDial/libtalk/rateDay read at4822e213: one mutable own0–100
rating per day, visible shared history; absence differs from0. Source fixed city
is replaced by explicit IANA and trusted today/expected-date rejection. No default50.
Own removal clears current value; deliberate new CAS publication is not restore.
No diagnosis, ranking, pressure, notifications or native/durable-offline claim.
100 lifetime dates per actor is a visible synthetic cap, not tariff or production.
Early code review and both exact-SHA FULLs pending; GitHub/main unchanged.

## Continue the phrase candidate after accepted6547291
Tan Ata stems page/TalkParts/libtalk: author commits beginning+own continuation;
recipient writes once before seeing it. Distinct from fixed-catalog blind rounds.
Added explicit skip/withdraw/split removal: skip never reveals author continuation;
completed recipient removal never relocks already revealed author text. Bundle
removal only erases own beginning/continuation, preserves partner response.
100 lifetime synthetic cap,500/2000/2000 codepoints, bounded full history; no AI,
notifications/native/production claims. Early review and both FULLs required.

## Diagnose original FULL failures before more product work
AcceptedStems6b5c72b had unexplained author/independent mobile exit1; later exact
diagnostics and full retries passed but do not identify original cause. A separate
runner slice retains private raw child output, never embeds it in report JSON.
16MiB per-stream prefix cap with full drain/hash; overflow/IO cannot yield accepted
evidence. Commands/env/timeouts/cleanup/coverage unchanged. Not a fix claim for
original flakiness. Next P1 deferred until reviewed logging checkpoint accepted.

## Ordered stories candidate after accepted316978a
The coordinator accepted log retention as Library v17 after both exact FULLs.
The next slice reads Tan Ata stories/page, StoryOrder/StoryTell, libtalk/actions
at4822e213, and compares existing Ask. The old week placeholder contradicts the
page/catalogue and is not adopted. Voluntary/no deadline already exist in Ask.
Distinct adaptation: topic300/narrative8000 codepoints, metadata-only100 history
and ACK, separate long composer/explicit reader, independent authored removals.
Both current members may explicitly read a told body immediately/repeatedly.
Early independent contract review passed after reader generation, newer-detail,
single-ACK gaps and exact wire-shape clarifications, before implementation.
Clock fixture failures preserved: pre-auth rollback was outside valid session;
invalid clock hits shared auth guard first. Only new tests corrected, not guards.
Focused API13/13 and mobile22/22 passed with four90% floors; a new UI composition
fixture failure is preserved (unstable captured identity fixed in own test).
Real HTTP/mobile and real PG race tests are added but unverified at this checkpoint.
Exact author/independent FULL remain required; native/two-device/production not run.
New product WIP has its own Library identity/version history; accepted v17 unchanged.
Early code reviewer found a confirmation surviving reset/rebind without panel unmount.
Unique controller reset generations now remount the confirmation owner; replacement
with another ready instance is fenced too. New regression tests use the same actor,
record and version. Mobile focused24/24 passed on555b59f with typecheck/lint and
four90% floors. These checks precede the required exact clean author/independent FULL.

## Hard question candidate after accepted67c6607 / Library v18
Actual Tan Ata hard page/TalkParts/libtalk/actions read at4822e213; opening is one
irreversible consent transition with later reads, not burn-after-reading. Recipient
sealed/declined text is never selected; author sees own active text. Added explicit
decline/author removal, technical2000/100 bounds, scoped current retry and RAM reader.
Semantic/API/mobile static reviews and focused API12/mobile25 passed. New realPG
wait/expiry/revocation/CAS and actualHTTP/mobile cases await runtime verification;
both exact FULLs remain required. Separate Hard WIP; accepted18/storyWIP4 unchanged.
Follow-up c07a6d7 focused API12/mobile27 passed, including the two added lifecycle/
retry combinations; no new lint warnings. RealPG and exact FULL results remain pending
at this frozen documentation checkpoint and will be recorded in external evidence.

## Shared-doing candidate after acceptedafd0770 / Library v19
Actual Tan Ata doings: two monotone personal positions and automatic both-complete;
distinct from SharedTasks single complete/reopen. Contract: docs/SHARED_DOINGS.md.
Explicit join/refusal, own-only progress, withdrawal clears own position, author
removal clears both. Default-off loopback API042, full100 history, title200/parts1000.
Initial API fixture-units/lint FAIL preserved; corrected focused API12/mobile29 PASS.
Reviewer found replay reachable-before but not after original operation; red5FAIL
preserved, applied-operation reachability now enforced with7 regressions PASS.
Real PG/HTTP/mobile scenarios added, first execution and both exact FULL still due.
Separate new WIP; accepted19/earlier WIPs unchanged. No native/two-device/production.
