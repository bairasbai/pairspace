# Вопрос дня: bounded synthetic SQL/API, 16 ноября 2026

Принят ограниченный synthetic SQL/API срез. Base accepted domain docs f8a6fa8227a172c6df1b095e7e1f4768ec8cfd78.
Domain semantics: [policy](DAILY_QUESTION_POLICY_2026_11_16.md). Этот этап только сервер;
нет UI/full daybook/native/production/E2EE claims. GitHub/production не меняются.

## Согласованные границы до implementation
Migration046: server-owned timezone pin для pair/epoch, immutable daily slots,
unique author/slot answers включая tombstones, metadata-only immutable command receipts.
Общий IANA zone приходит из construction-only trusted resolver; default UTC является
явным synthetic integration default, не выбором пользователя или production policy.
Первая явная POST запись фиксирует canonical zone на текущий pair/epoch. Изменение
resolver/config не меняет сохранённый pin; новый epoch имеет отдельный pin.
Request не принимает timezone, clock, actor IDs или авторитетную metadata.

GET `/v1/couples/:id/daily-questions` — metadata page и today prompt descriptor,
без скрытого создания slot. Query membership_epoch и optional before_day.
Keyset page максимум100 slots, before_day exclusive, hasMore/nextBeforeDay.
Нет lifetime cap: ежедневные ответы не блокируются после100дней; tombstones остаются.
Это bounded transport, не полный дневник и не сертификация всей истории одним GET.

POST collection создаёт собственный ответ и при необходимости slot атомарно.
Payload membership_epoch,command_id,confirm,expected_day,text. expected_day только
stale-day fence: фактические день/зона/prompt/участники определяются сервером.
PUT `/answers/:id` переписывает собственный сегодняшний ответ с expected_version CAS.
DELETE там же terminal-удаляет свой текст; recreate author/slot запрещён tombstone.
GET `/answers/:id/text` отдельно запрашивает текст. Slot/prompt immutable,
metadata list/ACK/receipt/replay не содержат текстов ответов.

## Privacy и transaction invariants
До private data: текущая session, active pair, ровно два текущих участника и epoch.
Повторные проверки после lock waits и перед return/commit; trusted clock nonregression.
До SELECT партнёрского body: canonical slot/target metadata, current auth и local-day
relation. TODAY дополнительно собственный canonical active непустой ответ: допустимо
сначала выбрать/валидировать СОБСТВЕННЫЙ body, не подменять его dummy text.
Future/invalid target metadata не разрешает partner body SELECT. Past active ответы
доступны независимо от собственного ответа, но только current scope.

Read сериализуется против own removal и concurrent writes. Tail повторно проверяет
auth/time и visibility, включая переход past→today при local calendar rollback.
Create/rewrite после ожидания и после writes/receipt обязаны оставаться в original
slot local day; иначе THROW rollback state+receipt+newslot/pin. Удаление стирает body
физически в transaction и сохраняет terminal metadata. Нет resurrection.

Replay идентифицирует original actor/command/payload/slot; после полуночи не создаёт
новый slot и не перенаправляется на today. Возвращается body-free CURRENT metadata
original slot/answer даже после удаления. Receipts не содержат raw text. Canonical
fingerprint не заменяет проверки binding, applied result и reachable progression.

## HTTP и будущая пользовательская прозрачность
Independent default-off synthetic loopback flag; trusted clock/zone только construction.
Strict unknown/duplicate JSON fields (decoded aliases тоже), query/header binding,
bounded body, Origin, no-store/nosniff и sanitized503. Новых dependencies не нужно.
Future UI перед отправкой должен явно объяснять past-day раскрытие даже без ответа
партнёра. Реализованный API не является выполненным UI disclosure gate.

## Verification plan
Light focused: exact parsers/contracts/projections, PGlite fault rollback и SQL guards.
После отдельного разрешения тяжёлого слота: real PostgreSQL observed locks/races,
simultaneous first slot/answer, ownremove-vs-partnerread, midnight afterwait/postwrite,
session/epoch revocation, lost ACK/replay afterday/removal; then exact FULL+independent.
На старте этапа FULL и realPG heavy запрещены до coordination GO; не запускались.
Все новые файлы≤600 строк, all-production coverage threshold≥90% по четырём метрикам.

## Ранний checkpoint и corrections
Initial WIP0b703fb не является accepted freeze. Early independent static review
обнаружил SQL defense gap: answer trigger брал pair lock, но raw INSERT/UPDATE мог
использовать старый slot после close/epoch change. Service authorization закрывал
обычный HTTP путь; наблюдавшийся HTTP bypass не утверждается. Answer/command guards
дополнены current active pair/epoch и exact current participant snapshot; directSQL
regressions подготовлены, ожидают разрешённого realPG запуска.

History теперь явно содержит hasMore + nextBeforeDay. Future local-day metadata
не возвращается read/replay даже при историческом rollback даты с возрастающим UTC.
Light PGlite service9/9 PASS до последнего SQL-guard rerun, service/helpers coverage
95.03/94.53/100/100% (S/B/F/L); HTTP/application4/4 PASS. Single migration smoke PASS,
включая11 catalog dates и immutable pin. Final light rerun фиксируется отдельно.
Actual HTTP/Better Auth и real PostgreSQL observed-wait fixtures подготовлены,
но НЕ запускались: тяжёлый слот пока не разрешён. FULL также NOT_RUN.

Corrected light rerun на hardened046:9/9 PASS, S287/302(95.03%),
B277/293(94.53%),F36/36(100%),L187/187(100%). Log `/tmp/daily-service-final.log`.
Prepared PG files syntax/node--check and targeted ESLint PASS. Planned guarded
PostgreSQL batch:15 service/race tests + actual HTTP/official-auth test; NOT_RUN.
Новый checkpoint сохраняется как WIP, не как независимая runtime-приёмка.

## Итоговая независимая приёмка
Ранние WIP/NOT_RUN записи выше описывают состояние до разрешения тяжёлого слота,
а не текущий статус. Проверенный code SHA:
`6c811e0e162d93a7e574c4ddc03eaf73a7192407`.
Tree: `a76597dd5282cb8e16a525a51923caa0c15c37d0`.
Авторский и независимый FULL:11/11 required gates PASS, sourceValid=true,
runner acceptance=true, clean before/after на одном exact SHA/tree.

Оба запуска: API1042 tests/102 files, mobile3242 tests/182 suites,
real PostgreSQL485 tests PASS. API coverage S/B/F/L:
98.51/97.54/99.79/99.51%; mobile95.78/95.48/96.31/97.50%.
Это all-production coverage соответствующих steps, не coverage verifier runner.

Author report:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-api-verification-runtime/pairspace-verification-x7KInn/report.json`
Independent report:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-api-independent-runtime/pairspace-verification-nLjSCl/report.json`
Focused realPG+official Better Auth HTTP:16/16 PASS; evidence:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-api-focused-postgres.log`.

Подтверждены observed lock waits, midnight rollback включая receipt/slot/pin,
current session/epoch/participant checks после ожиданий, собственный canonical
active nonempty today witness ДО SELECT чужого текста и terminal body wipe.
Raw SQL regression подтверждает исправление раннего defense gap после close,
epoch change/revocation; это не свидетельство наблюдавшейся HTTP-утечки.
Configured UTC остаётся synthetic default; immutable server-owned pair/epoch pin
не является готовым пользовательским timezone UX. History keyset100/page не
ограничивает число дней хранения. Body-free original-slot replay проверен.

Приёмка только bounded server storage/service/HTTP. Нового Daily UI нет;
UI disclosure о раскрытии прошлого дня, native/runtime/screenshots/devices,
production и E2EE не реализованы/не приняты этим этапом. Legacy Next build
NOT_RUN отдельно от11 required gates. GitHub/production не менялись.
Финальный checkpoint меняет только документацию: на его новом SHA новый FULL
не заявляется; проверенный production/test/lock контент остаётся exact6c811e0.
