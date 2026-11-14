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
Текущий измеренный PostgreSQL wrapper budget1110s и runner budget1140s
сохраняются, плюс15s TERM grace перед KILL. Внутренние per-test/SQL guards
и cleanup не ослаблены; обоснование прежних изменений бюджета находится ниже. Оставшиеся процессы группы после
выхода лидера делают шаг FAIL и принудительно завершаются.

## Что проверяется
Runner coverage; API typecheck/lint/full API+domain coverage; mobile typecheck/lint/
full mobile+domain coverage; PostgreSQL safety; реальный временный PostgreSQL;
root domain tests; Expo iOS/Android JavaScript export.
API/mobile include фиксируется CLI, все четыре порога >=90 задаются самим tool.
Свежий coverage-summary дополнительно проверяется: ненулевые denominators и
covered/total >=90 для statements, branches, functions, lines. Runner production
include перечисляет все семь собственных модулей, включая неимпортированные.
Tests/config не production; generated artifacts/dependencies не входят в coverage.

Root legacy Next typecheck/build явно NOT_RUN, optional и не считается готовым.
Полный локальный PASS не означает production readiness, native build, двухустройственный
E2E, E2EE или независимую приёмку. Эти ограничения входят в каждый report.

## Отчёт и приватность
Уникальная папка `/tmp/pairspace-verification-*`, runId, report.json, runtime/, logs/.
Отчёт сначала RUNNING/acceptance:false; атомарно обновляется после каждого шага.
Hard kill оставляет RUNNING, а не ложный PASS; старые отчёты не перезаписываются.
Сохраняются SHA/tree, hash каждого tracked file (для symlink hash link text),
aggregate hash и dirty state до/после. Файлы и executable mode также сверяются
с Git blobs HEAD независимо от assume-unchanged/skip-worktree и status cache. Untracked nonignored files делают baseline dirty.
Отчёты и caches находятся вне Git. Dependencies/ignored artifacts не являются source;
Git SHA не удостоверяет содержимое node_modules. Lockfiles входят в tracked manifest.
В отчёте есть exit/signal/error/timeout/duration, stdout/stderr byte counts и SHA256.
В schemaVersion2 содержимое stdout/stderr сохраняется в отдельных приватных
файлах logs/ (0700 папка,0600 файлы), но никогда не встраивается в report JSON.
На поток сохраняется не более16MiB; превышение сохраняет префикс, продолжает
считать полный hash/bytes и делает evidence incomplete/FAIL. Ошибка IO также
не допускает PASS; actual processStatus/exit/signal сохранены отдельно.
Не публикуйте logs/ или runtime/ целиком: raw-журналы не редактируются и могут
содержать синтетические payload тестов. Реальные данные/секреты запрещены.
Окружение allowlisted; credentials, NODE_OPTIONS и PG* не наследуются.
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

## Внешний запас времени API coverage

Для dd00c51 авторский полный API/domain coverage прошёл за234968ms при внешнем
лимите240000ms: запас всего5032ms (около2%). Независимый прогон того же исходника
превысил240s; это TIMEOUT, не PASS. Ранее тот же лимит уже давал timeout и успешный
повтор около227s. Причина конкретного замедления не доказана; результаты сохранены.

Новый внешний лимит300000ms: ceil(234968 *1.25 /30000)*30000. Это ограниченный
запас25% от измеренного успешного времени, округлённый до30s, а не скрытие падающего
теста. Независимая диагностика с полным output и новый FULL на новомSHA обязательны.
Меняется только timeoutMs шага api-domain-coverage. Набор тестов, full include API+domain,
все четыре coverageпорога90, --no-cache, конфигурационные testTimeout/hookTimeout30000ms,
maxWorkers1 и остальные бюджеты неизменны. Profile regression фиксирует точные args,
11обязательных шагов и все внешние бюджеты. Старые TIMEOUT не переименовываются вPASS.
Независимая точная диагностика dd00c51 после остановки неуспешного FULL:372/372теста,
60файлов PASS за233806ms при прежних240s (запас6194ms≈2.6%). Это не отменяет
прежний TIMEOUT и не заменяет два полных прогона после изменения бюджета.

## Measured aggregate PostgreSQL reserve after dictionary candidate
The c4e27b0 author FULL failed real PostgreSQL at750s. An exact750s raw diagnostic
also exposed5 earlier assertions: a transaction-cached pg_stat_activity query was
paired with live pg_blocking_pids. A deterministic regression proved the observer
bug; test-only snapshot refresh and settled cleanup fixed it in0d62b7c. This explains
those assertions, NOT the aggregate runtime increase from earlier731–741s results.
The reason for the aggregate slowdown remains unknown; no concurrent heavy author
or independent test process was intentionally running during measurement.

Approved diagnostic-only1200s run on0d62b7c completed407/407, zero failures/cancellations:
948s wall,944422.85ms Node duration. Reported test times sum859104ms; median1381ms,
p903476ms. Existing scheduled wait62230ms and morning waits98449ms; new dictionary
case7883ms. The diagnostic is not a replacement for either required frozen FULL.

Bounded reserve: ceil(948 *1.15 /30)*30 =1110s wrapper,1140000ms runner. The30s cleanup
margin,15s runner grace and10s timeout kill grace stay fixed. No per-test30s deadline,
SQL/query/lock/idle guard, test selection, concurrency, coverage include/threshold or
production behavior changes. Exact profile/entrypoint regressions protect this scope.
Prior failures and raw diagnostic evidence remain preserved. New SHA requires author
and independent FULL11; a diagnostic-only successful run is never admission PASS.

### API aggregate reserve after independent b4017a1 verification
Independent FULL exceeded300s for API coverage; its later PostgreSQL step was
interrupted by a cloud environment disconnection and is not accepted. After recovery,
exact300s API diagnosis also timed out:295 tests in45 files completed, no final summary.
An explicitly diagnostic600s run with the same arguments completed388 tests/64 files
in353535ms, exit0. Coverage statements99.10/branches97.32/functions100/lines99.53.
The diagnostic is evidence for sizing, not independent FULL acceptance. The cause of
aggregate slowdown remains unproven; no attribution to feature growth or disk/load.

Approved outer API deadline450000ms =ceil(353535 *1.25 /30000)*30000. Only the
api-domain-coverage timeout changes. Exact CLI arguments, includes, four90% floors,
no-cache, maxWorkers1, per-test/hook30s, all PostgreSQL guards and all other step
budgets are unchanged. The profile regression checks the complete manifest, exact API
arguments and every deadline. Prior timeout/interrupted reports remain unmodified.
New frozen SHA requires author FULL11 and independent FULL11 from scratch.

## Сохранность диагностик
Синхронная потоковая запись не накапливает очередь в RAM, но добавляет IO latency;
аргументы, окружение и лимиты процесса не изменяются. fsync и одна попытка close
выполняются перед итогом шага. При close error состояние закрытия ОС неизвестно:
слепой повтор может затронуть переиспользованный descriptor, поэтому ошибка
остаётся evidence failure. Hard kill/cloud interruption могут оставить partial
неиндексированные файлы, а report RUNNING: crash-proof полнота не обещается.
Подробнее: [VERIFICATION_LOG_RETENTION](VERIFICATION_LOG_RETENTION.md).
