# «Спор»: synthetic connected mobile, 16 ноября 2026

Статус: bounded synthetic mobile/controller/harness принят. Base3c78ad6 после accepted Dispute API и strict-enum fix.
SQL/domain semantics не меняются. Нет денежных ставок, расчётов или обязательств.

## Сценарии и границы
RU/EN экран Together, cream/terracotta tokens, 48-unit touch targets, accessibility
labels и KeyboardAvoidingView. Навигация сама ничего не загружает и не отправляет.
API adapter использует существующий independent default-off loopback-only backend.
Одно неизменное утверждение, optional nonbinding condition, будущая дата и IANA zone.
Recipient сначала явно читает active terms, затем отдельно подтверждает участие.
Вердикт тоже требует явно прочитанного matching id/version reader: карточки без
текста недостаточно для осмысленного одноразового решения. Reader показывает
claim, condition, дату и зону; close/reopen/другая запись инвалидируют подтверждение.
Контроллер требует reader того же id/version/current generation; metadata-list не
означает ознакомление. Close/loading/error/changed version/background очищают consent
context; повторное согласие требует нового чтения. В подтверждении показанные условия
остаются в reader; новый fetch не скрывается за кнопкой согласия.

Join до server-local due; decline/withdraw возможен и после due, но до verdict и не
означает проигрыш. Любой участник один раз указывает author/recipient/draw после due,
только joined. Author-only terminal removal сохраняет согласие/исход metadata.
Server checkedAt, а не часы устройства, используется для доступности кнопок; сервер
повторно авторизует действия. Нет автоматического итога или background mutation.

## Приватность, replay и lifecycle
List/ACK/replay body-free, explicit reader отдельно читает claim/condition обоим
участникам включая invited. Canonical metadata/progression и исходное событие команды
проверяются до принятия CURRENT replay; replay не выдаётся за прежнее текущее состояние.
Context/session/cookie/epoch проверяются после await; obsolete completions отбрасываются.
Неизвестная команда повторяется с тем же payload/id, новая форма её не меняет.
При подтверждённой отправке create исходный текст убирается из видимой формы.
Background/unmount/logout/scope reset abort + scrub draft/reader/pending payload.
После scrub неизвестного результата только refresh, не восстановление текста/команды.
Нет private durable cache, журналирования текста или скрытого повтора.
Удаление не отзывает ранее прочитанный текст и копии; предупреждение видно в UI.

## Evidence и оставшиеся gates
Focused state/proof7/7 PASS,100% all four; panel/composition22/22 PASS
(iOS/Android RU/EN harness), controller28/28 PASS. Controller all four >90%.
Early integration defect устранён: explicit detail не сертифицирует полноту списка
(checked=false), но per-record reader разрешает join/resolve по servercheckedAt.
Только create требует complete list. Real-controller+panel regression покрывает
refresh→read→join без лишнего refresh; mock-only tests этот разрыв не выявляли.
Actual controller + HTTP + official Better Auth + PostgreSQL18.6:1/1 PASS, без skips,
включая lost ACK/current replay, добровольное участие, draw, bodywipe и lifecycle.
Exact FULL и независимая приёмка завершены, см. ниже.
Native runtime/screenshots/keyboard/device accessibility NOT_RUN: harness не устройство.
В cloud PATH нет adb/emulator/xcodebuild, /dev/kvm отсутствует.
Никакой production/E2EE приёмки, GitHub ждёт разрешения владельца.

## Exact final acceptance
Source `ad06def79ff22115476308ca982be278143a5af4`, tree
`0bb5915769ad085a48434541ba41485551630723`.
Author `/tmp/pairspace-verification-E2IVRI/report.json`; independent
`/tmp/pairspace-verification-zIktm8/report.json`: оба FULL11/11 PASS,
sourceValid=true, clean before/after. API880/mobile3093 (181 suites)/real PostgreSQL469
PASS, PG skipped0. Focused57/57 PASS; все пять новых production файлов >90% all four.
Coverage обоих соответствующих steps, порядок S/B/F/L: API
98.64/97.58/99.78/99.48%; mobile95.75/95.42/96.26/97.48%.
Независимо проверены real-controller read→join fix, meaningful read-before-join/resolve,
reader identity/version/generation fences и неизменная серверная семантика.
Remaining bounded-scope blockers нет. Этот docs-only checkpoint код не меняет.
Native runtime, screenshots, keyboard/device accessibility и actual iOS/Android devices
NOT_RUN и не приняты. Harness и JS export не являются проверкой устройства.
Legacy Next gate NOT_RUN; нет production/E2EE/global-security acceptance.
GitHub публикация по-прежнему ждёт разрешения владельца.
