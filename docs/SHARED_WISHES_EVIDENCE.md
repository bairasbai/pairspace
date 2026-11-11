# Желания: протокол проверки synthetic-кандидата

Baseline: `0d38431ea029cc8dd6d01365b8d952d882c24ce5`, дерево
`572884cb175af57d01c5bef70d524ad58256ceba`, опубликованный эквивалент
`96b9a3580509a526f6f8960ea4fe9a2f65ebb084`. Изолированный cloud checkout.
Контракт: [SHARED_WISHES.md](SHARED_WISHES.md). До независимой проверки не принято.

## Тесты вместе с кодом
- API + PGlite: strict schema/HTTP, нормализация Unicode, необязательное пояснение,
  immutable payload, canonical retry, CAS и backward-clock updatedAt.
  Authorization до replay, обе пары, незнакомый/бывший участник, stale epoch,
  expired session и повторный session check. Latest50 со стабильным порядком.
- Real PostgreSQL: полная цепочка миграций, populated прежние tasks/songs,
  rollback новой migration019 без потери прежних строк; запрет изменения
  автора/текста/receipt, удаления и скачка version. Receipt failure откатывает
  создание и статус. Параллельные same-command retries создают одну запись;
  конкурирующие смены одной версии имеют одного победителя.
- Real PostgreSQL lifecycle: session expiry во время ожидания pair lock,
  closure-first race с create/change/list, запрет старого receipt после
  закрытия; новая пара не получает старую запись или command namespace.
- Actual composed mobile → HTTP → PostgreSQL: официальный тестовый auth/cookie,
  публикация только после согласия, отдельный private RAM draft, lost create/status
  ACK, неизменный retry, более новый статус партнёра и сохранение нового ввода.
  Конфликт → ручное обновление, foreign pair, unauthenticated, stale epoch,
  отсутствие task/outbox writes и RAM cleanup после закрытия пары.
- Mobile RU/EN UI/controller: consent, empty/malformed responses, duplicate clicks,
  cancel, offline/retry, newer draft, stale callbacks, cookie/session/epoch switch,
  unmount. Это JS boundary tests, не native/device E2E.

## Frozen проверка
Все 11 обязательных fail-closed стадий запускаются последовательно по
[VERIFICATION_RUNNER.md](VERIFICATION_RUNNER.md) на чистом frozen commit.
Physical pinned dependencies, отдельные scratch TMPDIR/HOME, Metro max-workers=2.
Coverage всего собственного production кода, включая неимпортированный, >=90%
для statements, branches, functions и lines. PostgreSQL guard 240s не ослабляется.
Проверки/артефакты вне Git; ошибки не скрываются. Точные SHA/tree, source hashes,
результаты стадий и checksums передаются отдельно в машинном report координатору.
Нельзя переносить PASS на последующий изменённый commit без новой проверки.

## Явные ограничения
Только synthetic connected, без production, preview/deploy, Space, платных сервисов,
личных данных и компьютера владельца. Независимая приёмка и публикация отдельно.
Сервер plaintext, не E2EE. Нет личных желаний, редактирования/удаления, архивирования,
назначений, покупок, внешних ссылок, доставки или автоматических уведомлений.
Default demo и чужие UI-изменения сохранены. Native iOS/Android build, device/two-device
E2E и legacy Next typecheck/build NOT_RUN. JS export не доказывает native build.
