# Вопрос дня и основание daybook: pure domain, 16 ноября 2026

Статус: bounded pure-domain этап принят после двух serial FULL и независимой проверки. Новый repo восстановлен только из verified Git bundle:
base d5718a12086c8da3e317ac039a16a345763a0bf3, tree
 d0e9e0f17cd03a87ff063a0b309a17974f5821b5; HEAD/tree и git fsck проверены.
Bundle без HEAD symref: явно выбрана его единственная feature branch. GitHub не
использовался; locked dependencies скопированы отдельно, не извлечены из bundle.

## Факты источника и адаптации
Pinned Tan Ata4822e213e991f6e8c0177751e0fd6626b1f237bc:
- components/DayAnswer.tsx, blob1d5858565664ab63a8ca147aa822a4be28112d78:
  общий вопрос, собственный ответ и повторное редактирование.
- lib/questions.ts, blob717d0a2bb87dd8b9a30bb5833ada28420ce125ee:
  deterministic date-cycle от2026-01-01,21 вопрос; snapshot вопроса не хранится.
- app/together/actions.ts, blobfc4c3014c9c981f683318e3a90a1d4a31729bb70:
  день определяется серверным todayInHerCity, не клиентом.
- lib/store.ts, blob2e1570c25c2cb89c6258282828e7b323b4b3db92:
  trim/nonempty upsert; чужой сегодняшний ответ скрывается до своего непустого.
- lib/keepsakes.ts, blob902b7d8c0b5124ec8d81964a2b99a1c6a4210890:
  прошлые ответы открыты обоим; для TODAY сохраняется условие своего ответа.
Независимый reviewer перечитывает source semantics. Исходные21 текста, персональные
идентичности, фиксированный пол/часовой пояс и код уведомлений не переносятся.
Ниже7 новых оригинальных нейтральных RU/EN prompts, versioned identity и snapshot,
terminal own removal, strict validation/CAS/proof — адаптации Amio.

## Общий день и стабильный вопрос
DailySlot immutable: UUID id, coupleId/epoch, sorted pair participantIDs, day,
canonical IANA timezone, server createdAt, catalogVersion, promptId, promptRU/promptEN.
Creation только для localDay(trustedNow, timezone); slot createdAt принадлежит дню.
Существующий slot должен сохраняться один раз для(couple,epoch,day). Его UUID уникален
и не переиспользуется, timezone/participants/prompt snapshot не меняются задним числом.
Это future storage invariant; pure policy не создаёт uniqueness constraint в БД.

Каталог amio-daily-v1 постоянный: UTC ordinal календарной даты от2026-01-01 modulo7,
включая отрицательные ordinal. Поддержаны canonical Gregorian dates0001–9999;
BCE/year0000 не поддержаны и fail closed. Это выбор вопроса по date label, не таймер24часа.
Новая версия добавляется отдельно, а не перезаписываетv1. Unknown version/ID и
snapshot, не совпадающий с закреплённым day/version, отвергаются; нет fallback.
RU/EN snapshot — неперсональный metadata, не текст ответа. Последующая смена языка
не заменяет исторический вопрос. Серверный pair zone snapshot общий для обоих;
смена настройки зоны не меняет существующий slot. Device clock не авторитетен.

## Ответ, редактирование и пропуск
Одна запись на actor/slot. Answer identity: id,slotId,coupleId,epoch,authorId.
Active хранит normalized text; metadata содержит версии/createdAt/editedAt/removedAt,
но никогда answer body. Текст1..2000 Unicode codepoints, raw max8000 UTF16 units,
NFC, trim, CRLF→LF, LF единственный допустимый control, lone surrogates отвергаются.
Create/rewrite требуют явного confirm, current scope, trustedNow в том же local day;
rewrite с expectedVersion CAS. После прочтения партнёром можно переписать сегодня:
это НЕ неизменяемый Blind round и не обещание синхронного раскрытия одной редакции.
Скрытых автоматических ответов, шаблонных заглушек или skip-as-answer нет.

Пропустить означает не отправлять ответ: нет persisted skip marker, версии и
разблокировки. Можно вернуться и ответить позднее сегодня. Это минимальная адаптация.
Author может terminal-remove собственный текст сегодня или позже; остаются body-free
metadata, old editedAt и removedAt, но не text. Удаление не восстанавливается и не
освобождает actor/slot для нового create; enforcement uniqueness — future storage.
Max version2147483646, active максимум2147483645 резервирует terminal removal.

## Чтение и необходимое будущее раскрытие пользователю
- Future slot: никакого чтения или изменения ответа.
- Today: свой active текст доступен; чужой только при собственном valid active
  непустом ответе на ТОТ ЖЕ slotId/pair/epoch. Обе full записи проходят валидацию.
- Past: оба current участника могут читать active ответы независимо от собственного
  ответа или пропуска. Это source-compatible foundation для daybook, не весь дневник.
- Own removal сегодня снимает право на новые чтения сегодняшнего чужого ответа.
  На прошлые active ответы партнёра правило собственного ответа не распространяется.
- Removed текст никогда не читается. Ранее прочитанные копии этим не отзываются.
- Invalid/rollback trusted clock до created/edited/removedAt fail closed, даже own read.

Будущий UI ДО отправки обязан сообщить: «Со следующего общего календарного дня
ваш активный ответ станет доступен партнёру, даже если он не ответил». Сейчас UI нет.
Историческое раскрытие не требует фоновой задачи: policy вычисляет relation по
trusted instant и immutable slot zone. Не добавляются mood scale, steps, статистика,
полный журнал, SQL/API, уведомления или экран.

## Scope, progression и проверка
Current pair/epoch и два participant IDs — доверенные входы будущего сервера.
Pure policy проверяет структурную принадлежность, а не реальную сессию/авторизацию.
Future API обязан загружать текущие canonical записи обоих ответов внутри scoped
transaction; клиентский stale active own после удаления не является read witness.
Constructor не обнаруживает ранее сохранённый tombstone без storage: обязательны
unique(actor,slot), canonical load и запрет recreate в будущей SQL реализации.
Все enum primitive exact, exact keys, canonical dates/instants, monotonic versions
и chronology. Follows обязан иметь допустимый rewrite/remove путь, а не только
увеличение версии; terminal не воскресает. Одновременные same-ms edits допустимы.
Future SQL должен ДО SELECT чужого body проверить target metadata+slot, current
auth/trusted day и наличие собственного canonical active nonempty ответа сегодня.
Затем full-body validation и tail auth/time check; нельзя сначала выбрать чужой текст
и считать один этот pure full-reader predicate pre-query authorization. Placeholder
body не допускается; этот этап SQL guard не реализует и не принимает.
Metadata proof не утверждает содержание чужого текста; read gate использует full
валидные записи, не один metadata marker. Возврат body только через отдельный gate.

Focused mirrored API/mobile и full coverage будут приложены после freeze. До exact
FULL и независимого review этап не принят. Existing PG regression не означает
реализованный Daily Question SQL/API. Native/device/production/E2EE NOT_RUN/не приняты.

## WIP corrections до freeze
Extended native-Node calendar tests обнаружили ошибку раннего formatter:
Intl calendar iso8601 не отдаёт era, чтение era могло выбросить исключение.
Исправлено Gregorian formatter с AD/BC; BCE fail closed, CE year padded4.
Независимый early review обнаружил sparse participant arrays: every пропускал holes.
Теперь оба UUID проверяются по явным индексам, mirrored regressions отвергают обе
формы holes. Это runtime validation defect, не наблюдавшаяся HTTP утечка.
Проверены также rollback local day при возрастающем UTC (Goose Bay1988), invalid
zone/scope, низкие годы и выход за9999. Ранний c05ca27 не является accepted freeze.

Corrected focused: API149/149 и mobile149/149 PASS; все5 daily production files
100% statements/branches/functions/lines в обоих движках. Оба typecheck и targeted
lint PASS. Это focused evidence, не замена exact FULL и независимой приёмки.

## Итоговая exact-source приёмка
Проверенный code SHA `680b8ffd41e6b55c51fdacc31781bce59a3d486c`, tree
`f375791181369044411861f0c7d48d4a154c01d0`.
Author report:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-verification-author-serial/pairspace-verification-twS0FY/report.json`.
Independent report:
`/workspace/scratch/bb7b759a56b3/amio-dev-20261116/daily-verification-independent-serial/pairspace-verification-X1Mfi7/report.json`.
Оба serial FULL11/11 PASS, sourceValid=true, clean exact source.
API1029 (99 files), mobile3242 (182 suites), real PostgreSQL469 PASS, skipped0.
Coverage S/B/F/L: API98.66/97.64/99.78/99.49%; mobile95.78/95.48/96.31/97.50%.
Focused149/149 в каждом движке, все5 новых production files100% all four.
Calendar Gregorian/BCE и sparse-participant corrections проверены до frozen SHA.
Это docs-only commit; production/tests/lock не меняются, нового FULL здесь нет.

Сохранены пять отрицательных/незавершённых прогонов, они не переименованы в PASS:
1. Independent EnrqgT: старт до завершения копирования dependencies, module-not-found,
   остановлен exit130; не source acceptance.
2. Author xTsq4h: abrupt exit1 mid-PG при наблюдавшемся полном /tmp tmpfs;
   report остался RUNNING/incomplete, не PASS.
3. Independent l3mnOC: тот же период полного /tmp, abrupt exit1 mid-PG,
   RUNNING/incomplete, не PASS.
4. Independent workspace vUyAMz: mobile SIGKILL, затем manual stop exit130 для
   освобождения тяжёлого слота, не завершённый FULL.
5. Author workspace3FDPOO:10/11 PASS, mobile coverage SIGKILL, итог FAIL;
   remaining PG469/root/export прошли. SIGKILL наблюдался, OOM не утверждается.
Serial retries использовали workspace TMPDIR после координации тяжёлых работ;
код, guards, coverage пороги и таймауты для прохождения не менялись.

Приёмка только pure catalogue/slot/answer domain и test harness. Existing PostgreSQL
regressions не проверяют Daily Question storage: SQL/API/UI ещё не реализованы,
их проверки NOT_RUN. Native/screenshots/devices/production/E2EE NOT_RUN и не приняты;
legacy Next gate NOT_RUN. Future SQL pre-query authority/current canonical witnesses
и disclosure past-day automatic visibility остаются обязательными следующими gates,
а не уже реализованными свойствами сервера или экрана. GitHub не менялся.
