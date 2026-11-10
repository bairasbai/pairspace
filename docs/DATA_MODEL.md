# Модель данных и транзакционные инварианты

Статус: целевая модель; реализованные synthetic-части отмечены отдельно.
Восстановлено 10 ноября 2026 года.
Типы ниже ориентированы на реляционную БД, предпочтительно PostgreSQL;
Конкретный managed-провайдер выбирается отдельно; миграции synthetic API
находятся в services/api/migrations и не означают production-развёртывание.

## Общие правила

UUID идентификаторы не дают права доступа. Все даты события хранятся в UTC,
пользовательский часовой пояс отдельно как IANA-имя. Календарная дата не заменяется
UTC-моментом; для повторений сохраняются локальная дата/время, пояс и правило DST.
Все данные пары имеют `couple_id`, включая дочерние таблицы и очередь событий.
Внешние ключи `(couple_id, resource_id)` ссылаются на уникальную пару полей родителя.
Изменяемые записи имеют `version`, `created_at`, `updated_at`, при необходимости `deleted_at`.
Системные каталоги вопросов не содержат couple_id; пользовательские ответы содержат.
Клиент никогда не назначает `user_id`, `sender_id` и роли из непроверенного тела.

## Аккаунты и членство

- `users(id, auth_subject UNIQUE, locale, timezone, status, created_at, deleted_at)`.
- `devices(id, user_id, session_id, platform, push_token_ref, revoked_at, last_seen_at)`.
  Сам push-токен шифруется/хранится секретно, не используется как ID человека.
- `couples(id, status, membership_epoch, next_chat_seq, created_at, closed_at)`.
  Статусы `waiting_partner → active → closed`; из closed обратно не переходим.
- `couple_members(couple_id, user_id, slot, status, joined_at, revoked_at)`.
  Уникальность `(couple_id,user_id)` и активного slot, slot ∈ {1,2}.
  Частичный unique по user_id для активного членства: в P0 одна активная пара на человека.
- `pair_invites(id, couple_id, token_hash UNIQUE, expires_at, consumed_by, consumed_at, revoked_at)`.
  Raw-токен возвращается только при создании, не хранится/не логируется.

Принятие приглашения блокирует couple и invite в транзакции, проверяет срок, статус,
свободный slot и отсутствие другой активной пары у приглашённого. Повтор тем же человеком
возвращает уже достигнутый результат, а не создаёт третье членство.
Разрыв блокирует ту же запись couple, меняет статус/epoch, отзывает оба членства,
отменяет приглашения и порождает outbox-событие. Все записи в пару используют тот же
порядок блокировок, чтобы исключить отправку после отзыва и уменьшить deadlock.

## Чат

- `chat_messages(id, couple_id, sender_id, client_message_id, seq, body,
  reply_to_id, version, created_at, edited_at, deleted_at)`.
- UNIQUE `(couple_id,seq)` и `(couple_id,sender_id,client_message_id)`.
- FK `(couple_id,sender_id)` → членство, не означает активность: её проверяет транзакция.
- FK `(couple_id,reply_to_id)` → сообщения той же пары. На чтении цитата вычисляется
  из текущей записи, не из неизменяемой копии текста в ответе.
- `chat_receipts(couple_id, user_id, delivered_seq, updated_at)`;
  составной PK, монотонная доставка. Публичное чтение не кумулятивно.
- `chat_read_receipts(couple_id,user_id,message_id,receipt_epoch,read_at)`;
  составные FK, unique participant/message. Принимать только текущую включённую эпоху.
  Чтение нового message_id не раскрывает чтение более ранних сообщений.
- `chat_user_state(couple_id,user_id,private_read_seq,read_receipts_enabled,receipt_epoch,muted_until)`.
- `chat_hidden_messages(couple_id,user_id,message_id,created_at)` с составными FK.
- `idempotency_records(user_id,couple_id,operation,key,request_hash,result_ref,created_at)`;
  UNIQUE по пользователю/операции/ключу. Не сохранять приватный текст в result.

Создание сообщения: lock couple → проверить active/epoch/member → проверить ключ →
выдать seq → insert message → insert outbox → COMMIT. После COMMIT допускается
повтор доставки события; запрещено второе сообщение для того же client_message_id.
После удаления body = null, остаётся tombstone для синхронизации и защиты от повторов.
Схема удаления/закрытия архива — предложение до ADR владельца, не разрешение стирать данные.
Удаление всей пары удаляет её содержимое согласно утверждённой retention-политике;
новые запросы отклоняются по закрытому членству, а не пересоздают записи.
Серверная история сортируется по seq, не по времени устройства.
Индексы: `(couple_id,seq DESC)`, `(couple_id,sender_id,client_message_id)`.

## Письма и общая жизнь

- `separations(id,couple_id,start_date,meeting_date,timezone,version)`:
  отсутствие пересечений задаётся ограничением БД или транзакционной проверкой диапазона.
- `letters(id,couple_id,sender_id,recipient_id,separation_id?,body,status,release_at,
  recipient_timezone,version,created_at,sent_at)`.
  Статусы `draft → sealed → available`, отмена/удаление отдельным переходом.
  Доступность проверяется серверным временем при чтении, не только фоновым заданием.
- `letter_reads(couple_id,letter_id,user_id,read_at)`; отдельная запись ответа с автором.
- `question_catalog(id,version,locale,category,prompt,safety_level)` и
  `question_answers(id,couple_id,question_id,author_id,body,visibility,submitted_at)`.
  Видимость ответа определяется явной механикой обмена; чужой черновик закрыт.
- `wishes(id,couple_id,author_id,title,visibility,status,version)`.
- `events(id,couple_id,author_id,title,local_date,local_time?,timezone,recurrence?,version)`.
- `tasks(id,couple_id,author_id,assignee_id?,title,status,due_at?,version)`.
- `moments(id,couple_id,author_id,caption,happened_on,version)` и связи с media_assets.
- `care_events(id,couple_id,sender_id,client_event_id,type,created_at)`;
  unique client_event_id в пределах отправителя/пары, rate limit для уведомлений.
- `game_sessions(id,couple_id,type,state,turn_user_id,version,status)`:
  правила хода проверяет сервер, не состояние клиента; ранняя версия может быть отложена.

## Совместные расходы

Первый этап — учёт, не банковский счёт и не движение средств.
`expense_entries(id,couple_id,author_id,payer_id,amount_minor,currency,category,
incurred_on,note,version)` и `expense_splits(couple_id,expense_id,user_id,share_minor)`.
Сумма целочисленная в минимальных единицах валюты, не float; доли должны сходиться.
Валюты не складываются без явно заданного курса/даты. Исправления аудируются метаданными,
без скрытой правки расчёта партнёром. Карточные реквизиты и банковские ключи не храним.

## Медиа, задания и согласия

- `media_assets(id,couple_id,owner_id,storage_key,mime_type,size_bytes,status,deleted_at)`:
  `pending → quarantined → ready` либо `rejected`; публичного URL в БД нет.
- `media_links(couple_id,asset_id,resource_type,resource_id)` требует конкретных FK
  для каждого типа в реализации; не оставлять непроверяемую полиморфную ссылку.
- `outbox_events(id,couple_id,type,aggregate_id,aggregate_version,created_at,processed_at)`.
  Payload минимален; текст сообщения не копируется в очередь.
- `notification_jobs(id,couple_id,recipient_id,event_id,dedupe_key,state,attempts,next_attempt_at)`.
  UNIQUE dedupe_key; состояние `pending → leased → sent` либо retry/cancelled/dead_letter.
- `ai_consents(id,user_id,couple_id,scope,version,granted_at,revoked_at)`;
  согласие одного не разрешает обработку приватных данных другого.
- `ai_insights(id,couple_id,owner_id,source_refs,claim,confidence,expires_at,deleted_at)`:
  не существует до согласованной реализации ИИ; удаление источника отзывает производный вывод.
- `subscriptions(id,couple_id,payer_user_id,provider_ref,state)` и
  `entitlements(couple_id,feature,valid_until)` не участвуют в ACL приватных данных.
- `deletion_jobs(id,couple_id?,user_id?,requested_at,state)` и минимальный журнал
  выполненных удалений для повторного применения после восстановления резервной копии.

## Миграции и приёмка

Порядок: users/devices → couples/members/invites → изоляция/политики → chat/outbox →
letters → бытовые модули → медиа → дополнительные сервисы. Каждый шаг отдельной миграцией.
Сначала additive-изменения, затем backfill/проверка, затем переключение, затем удаление
старого поля отдельным релизом. Проверить миграцию пустой и заполненной синтетической БД.
Откат приложения не должен требовать восстановления удалённой информации.

Тесты БД: третье членство, одна личность в двух активных парах, чужие составные FK,
параллельное принятие invite, гонки send/close, повтор POST после COMMIT,
конкурирующие правки version, удаление/повторная доставка, несовпадающие expense splits.
Тесты доступа: HTTP, realtime, storage, export, jobs и AI должны отвергать чужую пару.
До этих тестов схема остаётся проектом, а не реализованной защитой.

## Реализация letters (миграции 006–007, synthetic only)
Черновик остаётся только в RAM; таблица хранит отправленные немедленные и scheduled письма:
`letters(id,couple_id,sender_id,recipient_id,client_letter_id,membership_epoch,
body,created_at,release_at?,release_timezone?)`. Миграция 007 добавляет nullable
поля без изменения старых строк: null означает немедленную доступность. Составные FK связывают
обоих участников с парой; sender/recipient различны. UNIQUE `(sender_id,client_letter_id)`
не позволяет переиспользовать команду после смены пары. Повтор сравнивает
нормализованное тело, пару, получателя, epoch, release instant и timezone без перезаписи.
Запись блокирует пару, затем активные членства; чтение защищено совместимыми
блокировками. Сессия проверяется заново после ожидания. Все запросы отвергают
неактивную пару/членство; epoch не подменяет авторизацию.
Список возвращает последние 30 метаданных только текущему получателю. Отдельное
открытие фильтрует ID, пару, отправителя, получателя, epoch и release_at на сервере.
Доступность вычисляется при чтении по свежим часам сервера после lock/session recheck,
не хранится как stale status. Instant неизменяем; зона задаёт контекст, не сдвигает его.
Новый schedule: 60 секунд–366 суток, строгий offset ISO + IANA без угадывания DST.
Нет отметки прочтения, outbox/push, экспорта, редактирования или удаления.
Политика хранения до реальных данных требует отдельного решения.

## Synthetic завершение пары (008)
`pair_leave_commands`: append-only `(actor_user_id, command_id)` → старые
`couple_id`, `membership_epoch`, серверное `closed_at` (точное время исходного
события `couple.closed`); FK на историческое членство.
Нет текстов, токенов или сведений о новом партнёре. Receipt удерживается для replay;
это не утверждённый production-срок хранения.

POST `/v1/pair/leave` принимает `commandId`, `coupleId`, `membershipEpoch`, `confirm:true`.
Caller выводится из provider auth; ID и epoch клиента только immutable предусловия.
Все исторические domain users блокируются UPDATE в UUID-порядке до provider/session,
mapping и couple; fresh membership/session проверяются после ожиданий. Active → closed
увеличивает epoch, отзывает оба членства и непогашенные приглашения, создаёт один outbox.
Deferred constraint запрещает active members у closed pair; closed status/epoch нельзя
вернуть назад. Общий primitive защищает и прежний внутренний `closeCouple`.

Успех возвращает только `state:closed`, actor/session и исходные pair/epoch/command,
`replayed`; это не discovery текущей пары. Точный receipt после новой пары ничего в ней
не меняет. Параллельное подтверждение второго участника получает closed только по
точным прежним epoch, историческому членству и проверенному уникальному close event.
Смена командного payload, чужой ID и несогласованное состояние дают generic unavailable.

## Общие synthetic-задачи (009)
`shared_tasks(id,couple_id,creator_id,membership_epoch,title,state,version,created_at,updated_at)`.
Два текущих участника могут create/complete/reopen; `state` open/completed, `version`
растёт ровно на один при смене состояния. Creator/title/identity/scope/created_at
неизменяемы. Заголовок NFC, trim/collapse whitespace, 1–200 Unicode code points,
не больше 800 UTF-8 bytes; управляющие/невидимые format/surrogate символы запрещены.
Составной FK связывает автора с парой. Нет assignee/due/edit/delete в этом срезе.

`shared_task_commands(actor_user_id,command_id,couple_id,membership_epoch,task_id,
operation,expected_version,title?,applied_version)` имеет PK `(actor_user_id,command_id)`
и составные FK к историческому членству и задаче той же пары. UPDATE/DELETE receipt
запрещены. Create хранит нормализованный title, expected=0/applied=1; остальные
операции фиксируют task/operation/expected/applied=expected+1 без дублирования title.
Это synthetic дедупликация, не утверждение бессрочного production-хранения.

Авторизация использует порядок блокировок выхода из пары и свежую сессию после
ожидания; закрытая пара/чужой scope недоступны даже для replay. Новый scope не
наследует предыдущую команду. Replay подтверждает appliedVersion, но возвращает
текущее canonical состояние задачи: complete v2 после reopen v3 не откатывает v3.
Конфликт версии требует явного refresh; попытка изменить receipt отвергается.
Время ограничено точностью миллисекунд в БД; updated_at не убывает даже при
обратном ходе wall clock. Это сохраняет единый порядок SQL и мобильного списка.
Индекс `(couple_id,membership_epoch,created_at DESC,id DESC)` поддерживает окно
последних 50, одинаковое для обоих участников. Это не архив, retention или purge.

## Слепые ответы (010–011), synthetic
Неизменяемая цепочка раундов на `(couple_id,membership_epoch)` со snapshot двух участников
и точной парой question_id/catalog_version. Каталог встроенный, не содержит личных данных.
Ответ принадлежит конкретному round и его участнику; максимум один immutable submission
на человека. Receipt связывает actor/command с scope, round, question/version и ответом.
Повтор команды не изменяет ответ, но возвращает текущее разрешённое раскрытие.

Операции используют общий порядок `lockPair`, fresh provider session и membership
после ожидания. Snapshot должен совпасть с текущими двумя участниками active пары.
До двух submissions projection читает только собственное тело и наличие строк;
запрос чужого тела выполняется только после проверки двух участников. В API отсутствуют
чужие body/length/submitted/status до reveal. Список содержит только последние десять metadata, без тел и статуса отправки.
Закрытие пары/смена epoch/отзыв сессии блокирует read и replay, даже ранее раскрытых ответов.
Нормализованный ограниченный plaintext может читать сервер; это не E2EE. Данные не
попадают в логи/URLs/outbox/ошибки. Сроки retention и удаление здесь не определяются.

Исключение к общей рекомендации `couple_id` в каждом private child table:
в этом synthetic-срезе blind_answers и blind_commands ссылаются на конкретный
immutable blind_rounds.id. Scope выводится только из родителя; insert-trigger
проверяет actor по двум snapshot-участникам. Без авторизации родительского scope
доступа к дочерним телам нет. Это явное ограниченное исключение, не общий шаблон.

Миграция 011 добавляет nullable predecessor_round_id без изменения прежних записей.
Уникальные initial/successor ограничения и SQL insert-trigger под блокировкой пары
запрещают ветвление, пропуск и новый раунд до двух ответов текущего. Новый раунд
не обновляет существующий; каталог допускает три нейтральных RU/EN вопроса v1.
Legacy open/read остаются привязаны к первому small-joy v1. Явная next-команда
подтверждает predecessor и question/version; replay возвращает исходный target,
а не текущий раунд. История сортируется по цепочке, тела читаются отдельно.
Окно последних десяти не устанавливает retention и не открывает доступ бывшим участникам.

## Общие однократные даты: synthetic implementation
`shared_dates(id,couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at)`.
`local_date` — текст YYYY-MM-DD, настоящая григорианская дата 0001–9999, без
преобразования в UTC/instant. `timezone` — проверенное IANA-имя для контекста;
сервер сохраняет исходное проверенное IANA-имя без canonical rewrite. Разные
alias spellings — разные значения immutable payload; смена alias в том же
command даёт conflict. Intl проверяет поддержку, PostgreSQL — точное имя в
pg_timezone_names. Регистр сохраняется; неизвестное точное имя даёт invalid_request.
Retry не зависит от canonical spelling конкретной версии ICU. Native поддержка
зон и полей ввода отдельно не подтверждена.
`shared_date_commands` связывает actor+command, couple/epoch, title/date/zone и
созданную запись. Receipt и дата immutable; время создаёт сервер с ms precision.
Повторы авторизуются заново после блокировок users→pair и проверяют provider session.
Текущая активная пара должна содержать ровно двух участников. Закрытая пара
сохраняет строки по прежней archive policy, но не выдаёт их через list/replay.
Forward migration 012 не изменяет существующие данные. Чтение ограничено 50
последними созданными записями, created_at DESC/id DESC. Нет TTL или новой политики
retention, удаления, повторений, напоминаний и передачи внешним календарям.

## Ежегодные даты: additive synthetic implementation
Migration 013 добавляет к записи и receipt `recurrence` (once/annual) и
`leap_day_policy` (NULL/leap_years_only/feb28/mar1). Старые строки и прежний
create payload означают once/NULL. Annual с anchor 29 февраля требует явную
политику; для всех остальных комбинаций policy строго NULL. Generated NOT NULL
policy key участвует в composite FK, исключая обход FK через NULL.
Дата, заголовок, точная IANA-зона, recurrence и policy неизменяемы и входят в
идентичность повтора. Смена alias остаётся конфликтом, а не canonical rewrite.
`asOfLocalDate` и `nextOccurrence` вычисляются при ответе после fresh auth/locks,
не сохраняются как обещание уведомить. Серверный instant даёт дату в зоне записи;
само повторение рассчитывается без UTC, same-day inclusive и не раньше anchor.
Диапазон 0001–9999, Gregorian century rules; exhausted/unsupported-year metadata
возвращает NULL. Клиент проверяет согласованность next с schedule и server as-of.
Последние 50 по созданию не превращаются в ближайшие 50, полного архива нет.
Нет edit/delete, countdown, фонового scheduler, push или external calendar.
