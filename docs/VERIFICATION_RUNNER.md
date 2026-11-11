# Локальный fail-closed checkpoint

Это инженерный инструмент воспроизводимой проверки, не новая пользовательская функция.
Он не устанавливает зависимости, не публикует код и не развёртывает приложение.

## Запуск
- `npm run verify:plan`: фиксированный план, без исполнения и без acceptance.
- `npm run verify:runner`: только тесты самого runner; `acceptance: false` даже при PASS.
- `npm run verify`: весь локальный checkpoint; запускать на чистом committed checkout.
- Требования: Linux/POSIX, Node >=22.18, уже установленные API/mobile зависимости,
  bash/GNU timeout и существующие PostgreSQL prerequisites. В этом пакете проверяется Node 24.
- Нет внешнего config, произвольной команды, переменных окружения или output-path в CLI.

Каждый процесс запускается через child_process.spawn, shell:false, массив аргументов.
Runner продолжает независимые этапы после ошибки, но сохраняет её в итоговом exit code.
Отсутствующий executable, обязательный шаг, неверный manifest, timeout, signal,
нечистый исходный checkout или изменение source invalidates итоговую приёмку.
SIGINT/SIGTERM прерывает текущую process group; остальные шаги NOT_RUN.
Существующая внутренняя PostgreSQL защита 240s и cleanup не ослаблены: внешний
budget 270s плюс 15s TERM grace перед KILL. Оставшиеся процессы группы после
выхода лидера делают шаг FAIL и принудительно завершаются.

## Что проверяется
Runner coverage; API typecheck/lint/full API+domain coverage; mobile typecheck/lint/
full mobile+domain coverage; PostgreSQL safety; реальный временный PostgreSQL;
root domain tests; Expo iOS/Android JavaScript export.
API/mobile include фиксируется CLI, все четыре порога >=90 задаются самим tool.
Свежий coverage-summary дополнительно проверяется: ненулевые denominators и
covered/total >=90 для statements, branches, functions, lines. Runner production
include перечисляет все шесть собственных модулей, включая неимпортированные.
Tests/config не production; generated artifacts/dependencies не входят в coverage.

Root legacy Next typecheck/build явно NOT_RUN, optional и не считается готовым.
Полный локальный PASS не означает production readiness, native build, двухустройственный
E2E, E2EE или независимую приёмку. Эти ограничения входят в каждый report.

## Отчёт и приватность
Уникальная папка `/tmp/pairspace-verification-*`, runId, report.json, runtime/.
Отчёт сначала RUNNING/acceptance:false; атомарно обновляется после каждого шага.
Hard kill оставляет RUNNING, а не ложный PASS; старые отчёты не перезаписываются.
Сохраняются SHA/tree, hash каждого tracked file (для symlink hash link text),
aggregate hash и dirty state до/после. Файлы и executable mode также сверяются
с Git blobs HEAD независимо от assume-unchanged/skip-worktree и status cache. Untracked nonignored files делают baseline dirty.
Отчёты и caches находятся вне Git. Dependencies/ignored artifacts не являются source;
Git SHA не удостоверяет содержимое node_modules. Lockfiles входят в tracked manifest.
В отчёте есть exit/signal/error/timeout/duration, stdout/stderr byte counts и SHA256.
Содержимое stdout/stderr не сохраняется вообще: не публикуйте runtime/ целиком.
Окружение allowlisted; credentials, NODE_OPTIONS, PG* и request payload не логируются.
HOME/Expo и caches изолированы на запуск. Metro ограничен двумя workers:
неограниченный export в облаке завершился exit137; bounded preflight прошёл.
API dependencies должны быть физически внутри checkout для package-local PG guard. Vitest filesystem cache также свежий.

## Доказательства и статус
См. docs/evidence/VERIFICATION_GATE.md. Результат full checkpoint относится к точному
SHA/tree внутри report, а не автоматически к последующему коммиту документации.
Перед передачей сверить trackedHash с tested source, полный diff с base и checksums
артефактов. Независимый reviewer должен повторно проверить frozen commit.

## Запас времени PostgreSQL
Подготовка четырёх независимых accounts общего letters fixture ограниченно
параллельна; allSettled завершает запросы до cleanup. Тестовые процессы,
изоляция schemas, реальный release clock и timeout guards неизменны.
Диагноз и lifecycle regression tests: POSTGRES_VERIFICATION_RELIABILITY.md.
