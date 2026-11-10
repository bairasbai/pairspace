# Добровольное завершение пары: synthetic checkpoint

## Область
Только вымышленные данные, loopback и явный `enableSyntheticPairLeave:true`.
Default App остаётся offline demo. Новый путь не включает production/preview,
реальные аккаунты, push, экспорт, удаление или создание новой пары.

Один участник активной пары подтверждает завершение без разрешения партнёра.
Оба теряют обычный API-доступ к chat/care/letters, включая письма после release_at.
Записи остаются в БД. Waiting-only cancellation не реализован.

## Серверный контракт и гонки
- POST `/v1/pair/leave`: строго `commandId`, `coupleId`, `membershipEpoch`, `confirm:true`.
- Provider auth определяет actor; клиентский scope только фиксирует подтверждённую цель.
- Один общий `pair-close.ts` защищает новый handler и legacy `closeCouple`.
- Сначала discovery исторических участников, затем UPDATE-lock каждого domain user
  в UUID-порядке, provider/session/mapping и couple. После ожиданий проверяются
  свежие membership и session; изменившийся состав не подменяет первоначальную цель.
- Мутация атомарно закрывает пару, увеличивает epoch, отзывает членства и непогашенные
  приглашения, сохраняет единственный close outbox. Deferred constraint запрещает
  активные членства закрытой пары; закрытые status/epoch неизменяемы.
- `closed_at` каждого receipt копирует точное исходное `couple.closed.created_at`
  без округления, даже при позднем подтверждении второго участника или legacy close.
  Сам event использует `clock_timestamp()` после блокировок, не начало транзакции.
- Receipt `(actor,command)` append-only, привязан к исходным pair/epoch. Повтор с другим
  payload отвергается. Точный replay возвращает только старое closure metadata,
  даже если пользователь уже в новой паре: новую пару не читает и не меняет.
- Второй участник получает уже закрытый исход только при точном старом epoch,
  историческом членстве, отсутствии активных участников и проверенном close event.
- Chat send/read дополнены session recheck после ожидания couple lock.
- Ошибки не включают SQL/тексты, API no-store, composition проверяет origin и body limits.

## Мобильный контракт
- RU/EN показывает последствия и отдельное подтверждение; отмена есть до dispatch.
- При подтверждении очищаются chat/history/draft/queue, letters, care и invitation RAM,
  отменяются прежние сетевые запросы; provider credentials сохраняются.
- Исходный scope/epoch/command неизменяем, перед отправкой повторно сверяется контекст.
- Unknown ACK не означает успех: показан retry той же команды, без открытия контента.
  Abort/закрытие экрана не обещает отменить уже выполненную SQL-транзакцию.
- Receipt принимается только при точном совпадении session/user/pair/epoch/command;
  поздний ответ после logout/dispose или смены account игнорируется.
- Закрытие относится к «выбранной паре». Текущий аккаунт обновляется только отдельным
  явным действием, поэтому old receipt не объявляет новую пару закрытой.

## Synthetic-решения, а не owner ADR
Для этого тестового пути выбраны блокировка всех обычных API после закрытия,
сохранение записей и receipt, отсутствие автоматического rejoin/new pair.
Это не принятое решение о правах на production-архив и не retention/deletion policy.
Owner ADR для архива, удержания, экспорта и удаления остаётся открытым в SECURITY.md.
Сервер хранит plaintext; E2EE и независимая криптографическая проверка не реализованы.

## Проверки
Авторские финальные результаты:
- API: 204/204; coverage statements 99.30%, branches 98.95%, functions 100%, lines 99.89%.
- Mobile: 1127/1127; coverage 96.83%, 96.21%, 98.12%, 98.23% соответственно.
- Real PostgreSQL: 129/129, 155.18 секунды, включая фактическое ожидание release_at.
- API/mobile TypeScript и lint; iOS/Android JS export: прошли.
- Safety 9/9; root domain 9/9; diff-check и handwritten ≤600: прошли.
  Существующий machine-generated audit JSON (640 строк) остаётся явным исключением.
- Логи: `docs/evidence/pair-leave/`; runtime/migration/PG/mobile/domain manifest
  сравнивается до и после полного PostgreSQL прогона.

Покрыты две независимые пары, четыре участника, чужие ID/epoch, simultaneous leave,
leave/send/read и invite-accept races, late session expiry, official logout,
unknown ACK, rollback каждого write, сохранение архива, deferred constraints,
точное исходное время закрытия после lock wait и delayed partner/legacy acknowledgements,
старый receipt после новой пары, реальный mobile HTTP clean/lost-ACK flow.

Финальные результаты и frozen SHA передаются вместе с внешним manifest, чтобы SHA
не зависел от записи собственного значения в tracked-файл. Независимая приёмка
проводится отдельно и не заменяется авторским запуском.

Команды из корня:
- `cd services/api && npm run typecheck && npm run lint && npm test`
- `cd services/api && npm run verify:postgres && npm run test:safety`
- `cd apps/mobile && npm run typecheck && npm run lint && npm test && npm run export`
- `node --test tests/*.test.ts`
- `git diff --check` и проверка handwritten-файлов ≤600 строк.

Не запускалось: native iOS/Android build, реальные устройства/два устройства,
production, E2EE, публикация GitHub автором. JS export не является native build.
Известный отдельный root Next.js dependency blocker не относится к этому срезу.
