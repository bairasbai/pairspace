# «Спор»: storage/API bounded acceptance, 16 ноября 2026

Статус: bounded synthetic SQL/API принят после авторской и независимой проверки. Основание: domain67a606d и docsfb9dcea. Чистая семантика
из DISPUTE_POLICY_2026_11_16.md сохранена; здесь добавлены SQL/API, но не UI.
Никаких денег, расчётов, обязательств, платежей или автоматического исполнения условий.

## Контракт и ограничение
- Migration045 хранит scoped metadata, claim и optional condition. Immutable events,
  точные версии, неизменные условия, terminal removal с NULL обоих текстов.
- Технический предел100 записей за всё время текущей couple/epoch, на обоих участников
  вместе, включая tombstones. Это не свойство Tan Ata, не тариф и не entitlement.
- GET `/v1/couples/:id/disputes`: только metadata полной bounded истории, used/capacity
  и checkedAt. POST туда: claim, condition(null|string), judge_date, timezone,
  membership_epoch, command_id, confirm:true. Recipient определяется текущей парой.
- GET `/:disputeId/text`: отдельное чтение claim/condition обоими currentparticipants,
  включая invited до согласия и declined после отказа. После удаления body не выбирается.
- POST `/:disputeId/join`, `/decline`, `/resolve`; DELETE `/:disputeId`: command_id,
  expected_version, membership_epoch, confirm:true; resolve дополнительно winner_id
  участника либо null(ничья). Нет голосования двумя людьми или автоматического исхода.
- Join строго до judgeDate в выбранной зоне. Decline/withdraw до verdict разрешён
  и после даты, без проигрыша. Verdict только joined+due, один раз любым участником.
  Удаление только автором, сохраняет consent/outcome metadata, не восстанавливает текст.

## Metadata и privacy boundary
Active domain Dispute раньше содержал текст. Additive metadata.ts выделяет общую
строгую проверку scope/events/versions и body-free transitions/progression. Full-text
policy делегирует общие проверки и по-прежнему проверяет текст/его неизменность.
Нет фиктивного placeholder body. Metadata-парсер отвергает claim/condition keys,
а SQL использует явные колонки: list, ACK, receipt и replay не выбирают тексты.
Старые147 domain cases в обоих движках сохранены; добавлены19 parity/metadata cases.

Session, active pair, оба участника и epoch проверяются в транзакции до приватных
данных, после lock waits и перед выдачей. Actor predicates есть в scoped SQL.
Feature clock задаётся только при создании сервера; request clock не принимается.
После writes/receipt повторяются auth/time проверки: clock rollback, creation day
или join crossing judgeDate вызывают THROW и откат записи вместе с receipt.
Решение и конкурирующие decline/remove сериализуются CAS. Неизвестный ACK повторяется
той же командой, возвращает CURRENT metadata без повторного перехода и старого текста.
Receipt immutable, body-free; fingerprint не является единственным доказательством:
проверяются исходная операция/actor/version/outcome и допустимый путь applied→current.
Pair close сохраняет записи, но закрывает доступ по текущему pair/epoch контракту.

## HTTP
`enableSyntheticDisputes` независим, default-off, loopback-only. Trusted clock injection
отдельный; обычная production конфигурация не включается. No-store/nosniff, точный
Origin, bounded body/time и opaque503 сохраняются. Локальный JSON parser до JSON.parse
отвергает duplicate decoded keys, включая escaped aliases и nested objects, ограничивает
глубину/байты, проверяет UTF-8. Unknown fields, duplicate query и неоднозначный
Idempotency-Key отвергаются. Общий readJson других режимов не меняется. Зависимостей нет.

## Проверки и оставшиеся gates
Corrected focused: HTTP/application/strictJSON55 PASS; старые147+новые19 metadata
cases166/166 в обоих движках PASS, domain100% по четырём coverage метрикам.
PGlite9/9 PASS: service98.11/98.42/96.29/100% (statements/branches/functions/lines).
Реальные PostgreSQL16/16 плюс actual HTTP/BetterAuth1/1 PASS: observed pair/row/receipt-FK
waits, expiry/revocation, join crossing day, поздний rollback resolve/remove/create,
CAS, terminal replay, lifetime capacity и pair-close. Strict JSON100% all four.
Независимый early review обнаружил реальный inherited domain defect: String(contentState)
принимал ['active']/['removed'], а full-record wrapper мог пропустить отсутствие body.
Предыдущая domain-приёмка этот malformed-input случай не покрывала. Исправлено exact
сравнением enum; mirrored regressions охватывают массивы, object.toString и throwing
coercion, metadata/full-record/read/progression. Наблюдавшейся HTTP утечки нет; это не
отменяет дефект валидации. Bounded поиск других String(enum) в disputes их не выявил.
Focused не заменяет exact FULL11 и независимую приёмку по diff отfb9dcea.

Принципы дополнительного davila review применяются как checklist: точный base/head,
behavior-focused tests, ошибки/гонки/приватность и проектный порог90%, не установка CLI,
hooks, новых permissions или зависимостей. Reviewer принимает конкретный source SHA.
Нет UI/native/device/production/E2EE доказательств. Privileged direct SQL не является
application authorization; API boundary и trusted clock обязательны. GitHub публикация
ждёт явного разрешения владельца; main/production/компьютер владельца не меняются.

## Exact final acceptance
Source `8985a87870984178b877a2fb13fb3558a8020b9c`, tree
`d9ced1a6ebce4e26027124a0962493cddd21efed`.
Author `/tmp/pairspace-verification-KBkfir/report.json`; independent
`/tmp/pairspace-verification-XzCg2g/report.json`: оба FULL11/11 PASS,
sourceValid=true, clean before/after, API872/mobile3028/real PostgreSQL468 PASS.
Оба отчёта: API S98.63/B97.57/F99.78/L99.48%; mobile
S95.68/B95.36/F96.18/L97.41%. Значения взяты из соответствующих coverage steps,
не из runner coverage. Focused domain100% all four; service98.11/98.42/96.29/100%.
Независимая проверка enum correction и diff от fb9dcea: remaining scope blockers нет.
Документационный checkpoint не меняет принятый код.

Отдельный следующий этап: известные enum-validation defects Stories/Doings/Hard.
Они не исправлялись исходным Dispute checkpoint; позднее закрыты отдельным
accepted22ceb7a: [strict enum fix](ENUM_VALIDATION_2026_11_16.md). Исторический
дефект валидации не является наблюдавшейся HTTP утечкой. Acceptance
ограничена Dispute SQL/API и не является blanket app-security acceptance.
Dispute UI отсутствует. Native runtime/screenshots/devices, production и E2EE
не проверялись и не приняты; legacy Next gate NOT_RUN. GitHub всё ещё ждёт разрешения.
