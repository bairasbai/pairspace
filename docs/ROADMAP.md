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
