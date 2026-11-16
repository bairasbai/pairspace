# Вопрос дня: bounded synthetic client, 16 ноября 2026

Принят bounded synthetic mobile/controller/harness этап. Base accepted server docs897bc05574d8bc825e81dd00e707b18b77a82644.
Семантика: DAILY_QUESTION_POLICY_2026_11_16.md и DAILY_QUESTION_API_2026_11_16.md.
Отдельная local feature ветка/worktree daily-question-mobile. GitHub и production
не меняются; новые зависимости, уведомления, журнал настроений не добавляются.

## Scope и прозрачность
RU/EN экран в synthetic connected Together: текущий server question descriptor,
собственный ответ/create/rewrite/remove, explicit отдельное чтение и metadata history.
Keyset100 slots/page, load-more без lifetime ограничения или заявления полного дневника.
Нет автоматического чтения ответов при открытии/refresh/save/history pagination.
Skip означает отсутствие ответа, не создаёт запись и не разблокирует сегодняшнее чтение.

До отправки и в confirmation показывается предупреждение: со следующего общего
календарного дня активный ответ виден партнёру, даже если он не ответил. В контексте
показываются вопрос, общий день и pinned timezone. Device clock не даёт полномочий;
server checkedAt/today/immutable slot определяют UI affordance, а API заново проверяет
current session/pair/epoch и canonical own body. Metadata не подменяется dummy text.
Удаление terminal, ранее прочитанные копии не отзываются. Незавершённый черновик
только в RAM и теряется при уходе/фоне/выходе; скрытого сохранения нет.

## Контракты controller
Strict exact wire parsers: page/ACK/replay без answer body; только explicit reader
принимает canonical text. Unknown enums/fields/version/slot/prompt/clock fail closed.
Между страницами сохраняются known records/tombstones; отсутствие в старой странице
не является разрешением создать новый сегодняшний ответ. Create требует newest-page
completeness и отсутствия known own slot, сервер отдельно гарантирует uniqueness.
Reader очищается при refresh, смене версии/контекста, любых mutation и lifecycle.
Rewrite требует explicitly opened current own answer/version; новый draft не берётся
скрыто из ранее прочитанного текста. Confirmation привязана к controller/generation,
form revision, today descriptor, target identity/version и reader context.

Submitted draft очищается до сети; private mounted pending хранит только immutable
canonical retry payload. Потерянный ACK не считается успехом или own-answer witness.
Retry использует original command/day/version/text; midnight не переносит его на новый
день. Current replay доказывает достижимый результат original operation без требования,
чтобы overwritten editedAt совпал с исходной операцией. Новые drafts независимы.
Own removal сразу закрывает partner reader, в том числе при unknown/error результате.

Scope/logout/epoch/background/unmount abort+generation fences сбрасывают drafts,
read text и pending. Поздние success и failure не восстанавливают private view.
После scrub unknown outcome разрешается только refresh metadata; удалённый из RAM
payload не восстанавливается и не превращается в новую команду.

## Проверки и границы доказательства
Semantic review GO до implementation. Применён React checklist: стабильный external
store snapshot, cleanup подписок, прямые imports, derived state, explicit user events,
accessibility labels и минимальная touch target48. Не добавлены web/Next технологии.
State/proof focused7/7 PASS, оба production файла100% S/B/F/L; evidence
`/tmp/daily-mobile-state.log`, `/tmp/daily-mobile-state-coverage`.
Полный controller/panel focused и actual official-auth/PG scenario готовятся отдельно.
FULL, realPG и JS export НЕ запускались: тяжёлый слот пока запрещён координатором.
Native iOS/Android runtime, screenshots, keyboard/device accessibility NOT_RUN.
Jest platform/locale harness не является проверкой устройств. Production/E2EE не приняты.
До exact author+independent проверки статус WIP, отдельный Library checkpoint.

## Ранний проверяемый WIP
Combined light focused60/60 PASS,5 suites; five new production files coverage
S98.33/B97.59/F98.92/L100%, каждый файл≥90% всех четырёх метрик.
Log `../daily-mobile-focused-corrected.log`; coverage `../daily-mobile-focused-corrected-coverage`.
Предыдущий run `../daily-mobile-focused.log`:59PASS/1FAIL сохранён. Проверка frozen
metadata ошибочно ожидала throw от assignment в Babel non-strict runtime; корректная
проверка Reflect.set=false+unchanged metadata прошла. Это test assertion correction,
не снятие freeze guard. Ранний tsc во время незавершённого wiring и lint из неверного
cwd также не были PASS; corrected typecheck и targeted lint PASS отдельно.
Actual official-auth HTTP/mobile/PG сценарий подготовлен и syntax/lint проверен,
но runtime NOT_RUN до разрешения тяжёлого слота. Нет acceptance на этом checkpoint.

Final light rerun после явного next-shared-calendar disclosure и disabled locked-reader:
60/60 PASS, тот же aggregate98.33/97.59/98.92/100%; log `../daily-mobile-focused-final.log`,
coverage `../daily-mobile-focused-final-coverage`. Exact final code ждёт heavy checks.

## Предварительный independent review и calendar defense
На f7c41f7 blocking findings не обнаружены, но приёмка runtime ещё не выполнена.
Дополнительный malformed-response case: пустая более старая page могла подменить
current today.timezone при retained slots вне её range. Реальный immutable server pin
это исключал; HTTP-утечка не наблюдалась. Теперь continuity проверяет descriptor zone
против ВСЕХ retained slots и предыдущего trusted today, даже при empty incoming page.
Mismatch fail closed: descriptor/history/cursor не заменяются, reader остаётся закрытым.
Focused62/62 PASS;5 production files S98.34/B97.61/F98.93/L100%, каждый≥90all4.
Evidence `../daily-mobile-calendar-pin.log`, `../daily-mobile-calendar-pin-coverage`;
typecheck и targeted ESLint PASS. No FULL/realPG/export: coordinator запрет ещё действует.

## Итоговая независимая приёмка
Ранние WIP/NOT_RUN записи выше сохраняют chronology до разрешения тяжёлого слота;
текущий статус заменён этим итогом. Exact tested code:
`b2f9fbf332f1feed67f7a8b2c519647ac90603a2`.
Tree: `deead6bedf4b8ed8b413f0d540d45d88f820403a`.
Author и independent FULL11/11 required gates PASS, sourceValid=true,
runner acceptance=true, before/after clean на одинаковом SHA/tree.
Оба запуска: API1042 tests/102 files, mobile3304 tests/187 suites,
real PostgreSQL486 tests PASS. Coverage S/B/F/L:
- API98.51/97.54/99.79/99.51%.
- Mobile95.87/95.56/96.42/97.58%.
Это corresponding all-production steps, не coverage самого runner.

Author report:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-mobile-verification-runtime/pairspace-verification-Lox2RI/report.json`
Independent report:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-mobile-independent-runtime/pairspace-verification-ESVN0y/report.json`
Independent summary: `../daily-question-mobile-independent-review.txt`.
Focused actual controller→HTTP→official Better Auth→PostgreSQL1/1 PASS:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-mobile-focused-postgres.log`.

Подтверждены explicit reads без auto-fetch, today own-confirmed affordance (не
подмена server body authority), immutable unknown retries, terminal tombstone,
midnight day fence, scope/logout/late-response scrub и историческое раскрытие.
RU/EN предупреждение о следующем общем календарном дне присутствует до отправки
и в подтверждении. Calendar descriptor hardening empty older-page включён в exact
freeze. Сохранён negative59PASS/1FAIL: неверное ожидание throw в Babel non-strict
тесте заменено Reflect.set=false+unchanged; frozen metadata guard не ослаблялся.

Приёмка ограничена synthetic connected UI/controller, Jest iOS/Android/RU/EN harness
и actual HTTP/auth/PostgreSQL integration. JS export PASS не является native build
или запуском на устройстве. Native runtime/screenshots/keyboard/device accessibility
NOT_RUN и не приняты; production/E2EE не подтверждены. Legacy Next build NOT_RUN
отдельно от11 required gates. Mobile GitHub публикация в этом этапе не выполнялась.
Этот final checkpoint docs-only: production/tests/lock неизменны относительно
проверенного b2f9fbf; нового FULL на финальном docs SHA не заявляется.
