# Исправление своей песни: bounded synthetic-кандидат

## Объём
Baseline: e5be39412c551eab8a2b82dcd3b93f757ca472b5, опубликованное эквивалентное
дерево fbddb0f17cb907cff41ef877942c1beef18a4615. Отдельный cloud checkout/ветка.
Только автор исправляет название, своё объяснение и optional music URL; партнёр
видит изменения. Это улучшение сценария [карты Tan Ata](TAN_ATA_MAP.md), а не
утверждение о точном переносе всего исходного плейлиста или его production API.

## Приёмочный контракт
- PATCH требует свежую session authority, активную пару с двумя участниками,
  текущий epoch, автора записи и expectedVersion. Чужая пара/бывший участник
  не получают содержимое или старый receipt.
- Immutable actor+command receipt отделён от изменяемой записи. Create retry
  после edit и исторический edit retry возвращают текущую canonical запись.
- Конкурирующие правки одной версии имеют ровно одного победителя. Другой
  сохраняет черновик и получает конфликт без автоматического overwrite/rebase.
- Migration018 сохраняет populated no-link/link строки и исходные create receipts.
  Сбой записи receipt откатывает правку, а не оставляет половину команды.
- RU/EN: выбор только своей песни; явное согласие на видимость партнёру и кнопка
  сохранения. Выбор другой песни не уничтожает ввод: сначала явная очистка.
- Lost ACK удерживает исходные target/version/payload. Изменённый после отправки
  черновик переживает поздний ответ. Session/pair/epoch invalidation очищает RAM
  и не позволяет устаревшему callback восстановить данные.
- Latest50, createdAt/creatorId, отсутствие автозапросов, URL grammar и явная
  внешняя кнопка сохранены. Пустое поле формы удаляет ссылку; API null запрещён.

## Протокол проверки
Тесты пишутся вместе с реализацией: API/DB constraints, HTTP perimeter,
mobile controller/UI, actual mobile→HTTP→PostgreSQL, lifecycle/races и миграция.
Полный frozen checkpoint запускается через scripts/verification, последовательно,
с physical pinned dependencies, отдельными scratch TMPDIR/HOME, Metro двумя workers.
Все 11 обязательных стадий должны пройти; coverage всего собственного production
кода, включая неимпортированный, ≥90% statements/branches/functions/lines.
Ни failures, ни exit codes не скрываются. Reports/caches остаются вне Git.

Точный frozen SHA/tree, source hashes, результаты всех стадий и checksums передаются
координатору во внешнем report. Они относятся только к проверенному commit, а не
к последующей документации. До независимого review статус «не принято».

## Ограничения
Default App остаётся offline demo; connected API только synthetic loopback.
Сервер хранит plaintext, не E2EE. Не добавлены удаление, undo/history, ручной порядок,
архив, durable drafts, playback, previews, fetch или музыкальные аккаунты.
Native/device/two-device E2E и legacy Next typecheck/build NOT_RUN. Expo export
проверяет JavaScript bundles, не native build и не production readiness.
Нет production/deploy/preview/Space/платных сервисов/личных данных/компьютера владельца.
Публикация и независимая приёмка выполняются отдельно координатором.
