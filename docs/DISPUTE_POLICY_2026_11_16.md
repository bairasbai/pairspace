# «Спор»: ограниченный domain-only контракт, 16 ноября 2026

Статус: pure domain-only срез независимо принят. Основание: client docs55d5607. Нет SQL,
API, UI, уведомлений, native или production реализации. Это добровольная беседа,
не азартная игра, пари с денежной ставкой, платёж или юридическое обязательство.

## Проверенные факты источника
Read-only проверка Tan Ata на4822e213e991f6e8c0177751e0fd6626b1f237bc:
- [bets page](https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/app/talk/bets/page.tsx), blob79fe07db9677a704163c9beaabb27814ab354eef.
- [talk library](https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/lib/talk.ts), blob6f82acfdd2b842dce448ff227c2d7452bee6b4f6.
- [TalkParts](https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/components/TalkParts.tsx), blobeca73704c7e43b7304e73e9163e1547e80b236ef.
- [actions](https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/app/talk/actions.ts), blob574a9e88ad4d0ef22548cced1a99f580a557dad3.
Все четыре file SHA совпали, содержимое read-only file/blob ответов также совпало.

В исходнике одно утверждение claim, необязательное условие stake и календарная дата
judgeOn. «Две позиции» есть в подзаголовке, но отдельных текстов участников нет.
Выбор исхода: her/him/draw. Любой вошедший участник может один раз выбрать исход
после даты; SQL меняет только запись с пустым winner и judge_on<=today. Комментарий
о согласии второго участника НЕ подкреплён accept/decline state/action/UI.
Default/min завтра установлены в UI; startBet проверяет лишь непустое утверждение
и regexp даты, не будущий день/календарную корректность. todayInHerCity использует
Asia/Yekaterinburg (lib/time.ts blob22f75dcbfd11c13d41e2bc2cf5aa46582f82442d).
В рассмотренных функциях нет NFC/технических лимитов текста, редактирования,
повторного суда или удаления. Уведомление создания содержит фрагмент утверждения.
Исходный приватный код, личные тексты и уведомления сюда не копируются.

## Явные адаптации Pairspace
- Actor UUID вместо gender; собственные coupleId и membershipEpoch.
- Одно неизменяемое утверждение и optional nonbinding condition, а не две отдельные
  позиции. Нет amount/currency, баланса, долга, выплаты, escrow, расчёта ставок,
  исполнения условия или автоматической финансовой операции.
- Условие необязательное и не создаёт обязанности; только неденежное добровольное
  описание. Текстовый валидатор не является смысловым классификатором денежных фраз.
  Будущий UI обязан ясно объяснять эту границу; приложение ничего не взыскивает.
- Явное согласие получателя ДО даты; отказ до участия и добровольный выход после
  согласия, пока исход не зафиксирован. Отказ/выход не означает поражение.
- Проверяемая календарная дата, выбранный канонический IANA zone, explicit trusted
  server clock, CAS/confirmation, строгие переходы и авторское удаление текста.
- Никакого второго голосования или молчаливого автоматического решения. Один выбор
  любым участником после согласия и наступления даты, с сохранённым resolvedBy.

## Время и состояние
Создание: future local calendar day относительно trustedNow и выбранного IANA zone.
Дата Gregorian2000–2100, не elapsed24h и не часовой пояс устройства. Join допускается
лишь пока localDate(trustedNow)<judgeDate. Verdict допускается лишь после join и
localDate(trustedNow)>=judgeDate. Invited после срока не становится проигрышем,
не принимается задним числом; возможны decline или author removal.
Не вычисляется вымышленная UTC-полночь: при DST gap/fold сравниваются календарные
даты. Если зона пропускает весь выбранный день, порог достигается в следующий
реально существующий местный день. Часы не выводятся из Date.now или клиента.

Начало invited/version1. Recipient join добавляет joinedAt и одну версию.
Recipient decline добавляет declinedAt и одну версию; joinedAt сохраняется при
выходе. Decline допускается и после даты, но не после verdict. Joined resolve
добавляет resolvedAt/resolvedBy/winnerId и одну версию; winnerId только actor UUID
одного из двух либо null для ничьей, которую отличает ненулевой resolvedAt.
Автор может удалить в любом состоянии: removedAt + одна версия, без изменения
уже принятого согласия/отказа/исхода. Тексты claim/condition полностью отсутствуют
в removed форме; будущая БД обязана стереть оба физически в той же транзакции.
Removed terminal: нет повторного участия, решения, изменения или восстановления.

Chronology: created<=joined<=declined/resolved<=removed, равенство при миллисекундном
clock допустимо. Version строго1 + число событий join/decline/resolve/remove.
Не все наборы событий допустимы: decline исключает resolve; resolve требует join;
события старой версии неизменяемы. Progression proof проверяет достижимость пути,
не только рост версии: нельзя дописать join перед старым decline, изменить outcome,
вставить событие до предыдущего наблюдаемого времени или воскресить удалённый текст.

## Текст и авторизация
Claim1–2000 Unicode codepoints, condition null либо1–500, NFC и внешнее trim.
CRLF нормализуется в LF, внутренние абзацы сохраняются; loneCR, controls и broken
surrogates отвергаются. Пустое optional condition означает null. Текст неизменяем.
До согласия оба участника видят условия, чтобы согласие было осмысленным. Decline
не раскрывает дополнительного контента; до авторского удаления terms доступны обоим.
Фоновые задания/посторонние/другая пара/старая эпоха не получают scope-права.

Domain scope и trustedNow являются входными предпосылками, НЕ реальной проверкой
сессии или текущего членства. Будущий API обязан проверить их внутри транзакции,
повторно после lock waits и перед private projection. Здесь нет real auth/storage,
идемпотентных receipts, лимита количества записей или offline/cache реализации.

## Приёмка и ограничения
Semantic plan проверен до кода. Pure TypeScript policy, mirrored API/mobile tests,
focused coverage>=90% по всем четырём метрикам, frozen FULL11 и независимый review
точного SHA завершены ниже. Эти проверки не реализуют SQL/API/UI и не закрывают P1.
GitHub публикация запрещена до явного разрешения владельца; локальная ветка и Library
сохраняются отдельно. main/production/компьютер владельца не меняются. Никаких
native/device/E2EE/production обещаний из domain-only приёмки не следует.

## Focused checkpoint перед FULL
API147/147 и mobile147/147 PASS. Тесты зеркальны, отличаются только Vitest import.
Оба движка: policy+validation100% statements/branches/functions/lines. Граф из20
состояний проверен всеми400 парами для обоих участников, включая равные timestamps,
withdraw/decline, исходы обоих actors и ничью, removed и недостижимые переходы.
Проверены DST, пропущенный местный день, future-day/join/resolve границы, NFC/лимиты,
чужой scope/epoch, malformed runtime scope, отсутствие body keys в tombstone.
API/mobile typecheck и focused lint PASS; initial unused body destructure/tuple style
lint замечания исправлены без suppression. Diff check PASS. На этом focused checkpoint
FULL и независимая приёмка ещё ожидались; их итог приведён ниже.


## Итоговая независимая приёмка pure domain
Оба FULL прогона прошли11/11 обязательных gates на точном коде
`67a606d902a71a9167adefc3238146617bec204f`, tree
`4435070102ca4d3d38e4ae2d0504973e0062ed30`, sourceValid=true, clean/unchanged.
Последующий checkpoint меняет только документы, не принятый код.
- Author report: `/tmp/pairspace-verification-KJ4ydi/report.json`.
- Independent report: `/tmp/pairspace-verification-3IGuJH/report.json`.
- Оба: API789/789 (92 files), mobile3009/3009 (174 suites), PostgreSQL451/451,
  без skipped PostgreSQL tests. Legacy Next build/typecheck намеренно NOT_RUN.
- API coverage: statements98.62%, branches97.53%, functions99.88%, lines99.46%.
- Mobile coverage: statements95.67%, branches95.36%, functions96.16%, lines97.40%.
- Независимый reviewer принял только bounded pure domain, без оставшихся blockers.

Дополнительный read-only review по davila code-reviewer/generate-tests, применённый
к55d5607→67a606d, не нашёл новых подтверждённых дефектов. Это дополнительный анализ,
не новый runtime-прогон, установка инструмента или замена основной независимой приёмки.

## Следующий серверный этап, не выполнен
Для будущего SQL/API нужны текущая session/pair/epoch и trusted clock внутри tx,
повторные проверки после lock waits и перед private projection; resolve-vs-decline,
resolve-vs-remove и join-at-date races; неизменяемые metadata-only receipts/replay,
без body в ACK/list/receipt, атомарное удаление claim и condition. Нужны реальные
PostgreSQL/HTTP проверки, отдельный default-off флаг и новая независимая приёмка.
Успех существующих451 PG regression tests НЕ проверяет отсутствующий DisputeSQL/API.
UI, native/device/E2EE/production тоже не реализованы и не приняты этим срезом.
GitHub публикация по-прежнему ждёт явного разрешения владельца. main/production не
менялись; Library упаковка отдельно. Временные report paths обозначают локальные
доказательства, не постоянные пользовательские ссылки загрузки.
