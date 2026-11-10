# Ежегодные общие даты: bounded synthetic-срез

## База и статус
Опубликованная база c9dbb6f8dfe5f6217744bf70c92f341c57df39a3 соответствует
локальной 089828737b0312d1e75c183f73c81c3bd12926a1 по tree
c902e859df60f1f83d55dd668a47af8753922fb2. Работа ведётся отдельной веткой.
До независимой приёмки exact frozen SHA: **не принято**.
Нет production, preview, внешних calendar writes, GitHub publication или личных данных.

## Контракт и гарантии
- Additive migration 013 сохраняет старые записи и receipts как once/NULL;
  legacy create payload остаётся допустимым. Поля recurrence и leapDayPolicy
  входят в неизменяемое тело и ключ совпадения receipt. NULL policy не обходит FK.
- Annual 29 февраля требует явного выбора: leap_years_only, feb28 или mar1.
  Другие даты и once принимают только NULL; скрытый выбор отсутствует.
- Pure Gregorian arithmetic сохраняет календарные labels, не использует UTC
  midnight и не зависит от DST. Правила 1900/2000/2100 и диапазон 0001–9999 явны.
- Следующая дата same-day inclusive и не раньше anchor. Будущий anchor не создаёт
  событие в более раннем году. После исчерпания диапазона nextOccurrence=NULL.
- Сервер получает свежий instant после authorization/locks и вычисляет
  asOfLocalDate в точной IANA-зоне. Intl используется только для zoned today.
  Серверная дата вне диапазона или недоступная зона дают NULL metadata без догадки.
- Exact IANA aliases не переписываются; unsupported server catalog zone даёт 400.
  Replay с изменённым title/date/zone/recurrence/policy конфликтует.
- Mobile проверяет точную схему, разрешённую пару/epoch, согласованность next
  с schedule и as-of. Device clock не участвует. RU/EN сообщает ручной refresh,
  дату расчёта и честное отсутствие следующего события.
- RAM pending остаётся неизменяемым после неизвестного ACK даже при новой
  редакции draft. Cookie/session/context/epoch guards и privacy clearing сохранены.
- Список по-прежнему latest 50 creations, не ближайшие события и не полный архив.
  Нет edit/delete, reminder, push, countdown, scheduler или фоновой отправки.

## Проверки автора
- Mobile: 53 suites / 1409 tests passed, coverage statements/branches/functions/lines
  97.03/96.13/98.22/98.60%.
- TypeScript и lint API/mobile passed; root 9/9 и safety 9/9 passed.
- iOS и Android JS exports passed, не native builds.
- API: 35 suites / 242 tests passed, coverage 99.36/98.76/100/99.91%.
- Real PostgreSQL: 189/189 passed, включая populated legacy migration, все Feb29
  policies, immutable unknown ACK и real-lock clock/auth regressions.
- Полный baseline → candidate diff-check, ≤600 строк handwritten и
  high-confidence secret-pattern scan passed; новых dependencies нет.
Логи: `docs/evidence/annual-dates/` и `apps/mobile/evidence/annual-dates/`.
Exact SHA/tree и SHA256 archive/patch фиксируются отдельным manifest после freeze.
Авторская проверка не заменяет независимую приёмку.
Первый mobile export выявил недоступный default Expo home, затем external symlink
resolution Metro. Writable temporary home и локальная копия baseline dependencies
решили только environment setup; полный mobile набор после этого повторён.

## Ограничения
Native iOS/Android, физические устройства, два устройства, VoiceOver/TalkBack,
Hermes Intl/timezone availability не проверены. JS exports не native builds.
Root Next build: прежний blocker `next: not found`; зависимости референса не менялись.
Новых зависимостей нет; API toolchain скопирован из baseline для безопасного
локального PostgreSQL runner, mobile toolchain также скопирован из baseline без manifest/lockfile изменений.
Server plaintext; E2EE, production retention/deployment/security не заявлены.
Старые evidence files описывают свои исторические once-срезы, а не текущий контракт.

## Исправление проверки после первого freeze
Первый candidate 0b0d0a9 ошибочно утверждал успешный mobile typecheck: его log
содержал TS5097. Shell-композиция `lint && typecheck; tail; git status | head`
возвращала код последней команды, а законченный log не был проверен повторно.
Это ошибка проверки автора, не успешная приёмка первого candidate. Исходный
failed log сохранён как `typecheck-initial-failed.log`; итоговый `typecheck.log`
получен отдельной командой с явным exit status, без маскирующего trailing pipeline.
Mobile tsconfig теперь разрешает explicit .ts imports при уже включённых noEmit,
strict и bundler resolution. Это согласует shared domain с Node TypeScript runtime,
не отключая проверки типов. Итоговые команды используют set -euo pipefail и
проверку каждого exit code; completed logs просмотрены непосредственно.
