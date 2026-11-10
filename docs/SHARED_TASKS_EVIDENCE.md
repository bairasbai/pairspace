# Общие задачи: ограниченный synthetic checkpoint

## Область и статус
Только вымышленные данные и явный loopback opt-in `enableSyntheticSharedTasks:true`.
Default Kimi App остаётся offline demo. Реализация не является production-запуском.
Независимая приёмка точного SHA требуется отдельно; автор не принимает свою работу.

Оба активных участника могут создавать общие задачи, отмечать выполненными и
открывать снова. Список содержит последние 50 по созданию, не полный архив.
Нет назначения, сроков, редактирования заголовка, удаления, push или фоновой доставки.
Тексты приватны, не попадают в URL/логи; серверный plaintext не означает E2EE.

## Контракт
- GET `/v1/couples/:coupleId/tasks?membership_epoch=N`: tasks и явный limit=50.
- POST того же пути: command_id, membership_epoch, title.
- POST `/tasks/:taskId`: command_id, membership_epoch, operation complete/reopen,
  expected_version. Idempotency-Key должен совпадать с command_id.
- Mutation ACK: текущая task, commandId, replay и исходная appliedVersion.
  Повтор после дальнейших изменений не утверждает, что историческое состояние всё
  ещё актуально. Версии нельзя молча перезаписывать: конфликт требует refresh.
- Actor выводится из аутентификации; scope/epoch/ID клиента лишь предусловия.
- После ожидания lock проверяются свежая сессия, пара, два участника и epoch.
- Command receipt неизменяемо связан с actor, pair, epoch, operation, task,
  expected version и нормализованным заголовком. Тот же ключ с другим payload запрещён.

## Мобильный путь
Один controller принадлежит connected App. Черновик хранится в RAM и отделён от
неизменяемого pending command. Неизвестный ACK допускает повтор исходной команды;
смена черновика не переписывает отправленное действие. Поздние ответы после смены
scope/logout/dispose не возвращают приватный контент. Список обновляется явно.
Отмена локального ввода не обещает откат уже отправленной серверной транзакции.
RU/EN показывает ограниченное окно и различает успех, retry, конфликт и отказ.

## Проверки
Авторские результаты на финальном runtime:
- API: 211/211, 30 suites; coverage statements 99.29%, branches 98.81%, functions
  100%, lines 99.90%. Focused shared-task/composition: 20/20.
- Mobile: 1203/1203, 42 suites; coverage 96.95%, 96.22%, 98.33%, 98.38%.
- API/mobile TypeScript и lint: прошли. iOS/Android JS export: прошёл.
  Expo cache использовал временный writable HOME; source/config/dependencies не менялись.
- Root domain 9/9; safety 9/9; handwritten limit: прошли.
- Первичная проверка diff-check охватывала лишь чистый working tree и не доказывала
  отсутствие whitespace-ошибок в полном изменении. Reviewer обнаружил их в generated
  evidence logs; удалены только trailing whitespace и лишние пустые строки EOF.
  После исправления `git diff --check 9fe0a93176d28c4f10fa971ba7d59478ed5b79c0 HEAD`
  проходит для полного среза. Runtime, миграции и тесты этим исправлением не менялись.
- Real PostgreSQL focused: 15/15. Полный прогон: 144/144, 172.37 секунды.
  Runtime/migration/PG-test/mobile-runtime/domain manifest до и после идентичен.
- Логи и manifest: `docs/evidence/shared-tasks/`.

Команды: API/mobile typecheck, lint, coverage; real PostgreSQL suite с двумя парами,
concurrency и unknown ACK; root domain; safety; iOS/Android JS export; diff-check;
лимит 600 строк рукописного файла. Outer timeout полного PG набора расширен со 180 до 240 секунд из-за роста
проверок и прежнего 61-секундного ожидания scheduled letter; safety-тест фиксирует
новую границу. Per-test 30 секунд и bounded query/cleanup сохранены.
Manifest runtime/migration/tests до и после PG
прогона исключает смешение результатов разных ревизий.

Не запускалось: native builds, устройства/два устройства, production, E2EE,
архив/экспорт/retention/deletion и публикация GitHub автором. Root Next dependencies
остаются отдельным известным ограничением. JS export не является native build.
Frozen SHA/tree и checksums исходного архива/patch передаются внешним manifest,
чтобы tracked-файл не ссылался на собственный ещё не вычисленный commit.
