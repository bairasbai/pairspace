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
