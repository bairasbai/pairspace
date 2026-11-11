# PostgreSQL checkpoint: bounded fixture preparation

## Диагноз 2026-11-11
Baseline: local `9dabd18d7674718473b049f8eb323efb0b64723a`, published
`10c75cfc6028f8ac7de8068fd09d0401e0599db8`, tree
`8acb7fe26f28c569c807dd807c87e1b10ce1cecf`.
Предыдущие full reports: PostgreSQL 234.156s (author), 233.916s (reviewer).
Диагностический запуск с временными timing logs: 215/215 PASS, 0 skipped,
wall 239.744s, node test 237.966s. Это измерение, не frozen acceptance.
238 fixture setups: 26.031s; domain migrations 17.966s, provider migrations 5.941s.
Сумма test durations 216.858s; остальное включает process/import overhead.

Восемь чередующихся real PostgreSQL замеров одинаковых четырёх signup:
среднее sequential 355.816ms, parallel 128.709ms. Использованы настоящий
loopback HTTP, Better Auth и штатный password hashing. Это benchmark preparation,
не замена полного security/integration checkpoint и не гарантированное SLA.
Отдельно исследованы migration batch и свежий Node compile cache; эти варианты
не включены: для данного изменения достаточно ускорить независимые signup.

## Изменение и инварианты
Только `letters-fixture.mjs`: четыре независимых synthetic accounts создаются
параллельно внутри одного fixture; число запросов ограничено четырьмя.
`Promise.allSettled` дожидается всех результатов даже после первого отказа,
затем ошибка передаётся существующему cleanup. Порядок identities/connections
соответствует input 0–3, а не времени ответа; provisioning пар начинается позже.
Новые тесты принудительно меняют порядок завершения, проверяют official sessions,
разные cookie, mapping/slots, независимые schemas, закрытие одного fixture при
сохранении другого и отсутствие schema/provider/domain connections после ошибки.

Процессы тестов остаются последовательными. Каждая проверка получает новый schema,
новые identities и cookies; ни пользовательское состояние, ни password hashes,
ни sessions, ни мигрированная БД не переиспользуются. Production auth и migrations
не менялись. Все старые integration assertions и реальный 61s release wait сохранены.
Guard 240s, outer budget 270s и per-test bounds не повышены; тесты не исключены.

## Проверки и ограничения
Первый focused lifecycle run: 1 PASS / 1 FAIL. Новая проверка ошибочно читала
composed cookie через отдельный authority fixture; исправлена на официальный
composed client `getSession`. Повторный focused run: 2/2 PASS, 0 skipped.
Оба лога сохранены вне Git. Диагностический launcher `/usr/bin/time` отсутствовал;
сам baseline запущен с shell `time`. Неверный cwd первого eslint вызова дал
ложные missing-globals ошибки; lint затем запускается из корня репозитория.
Старые FAIL reports не удаляются и не заменяются поздними PASS.

Full all-eleven checkpoint обязателен после frozen commit. Его точный SHA/tree,
coverage, длительность PostgreSQL и before/after manifests находятся во внешнем
report. Измерения и focused tests выше не объявляют этот ещё не выполненный gate
успешным. Независимая приёмка остаётся за reviewer точного frozen SHA.
Export — только JavaScript iOS/Android, не native build. Legacy Next NOT_RUN;
production, E2EE, two-device E2E и полная готовность продукта не подтверждены.
