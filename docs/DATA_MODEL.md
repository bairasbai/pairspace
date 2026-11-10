# Модель данных и транзакционные инварианты

Статус: проект схемы, не существующая БД. Восстановлено 10 ноября 2026 года.
Типы ниже ориентированы на реляционную БД, предпочтительно PostgreSQL;
конкретный managed-провайдер выбирается отдельно. Миграции ещё не созданы.

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
