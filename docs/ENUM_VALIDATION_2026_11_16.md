# Strict state enums: Stories / Doings / Hard, 16 ноября 2026

Статус: bounded strict-enum fix принят после авторской и независимой проверки. Отдельный bounded fix от принятого Dispute API docs
`da8fd2bd94fc104c897442225ce3452d3449062f`; SQL/API/UI/продуктовые правила не меняются.

## Подтверждённый дефект и границы
Независимый audit показал, что String(state) допускает массивы и объекты вместо
primitive enum string. Stories topic/story states, Doings content state и Hard
content/decision state в некоторых malformed records проходили валидацию.
Doings decision state в исходном конкретном repro уже отсеивался последующими
проверками, но тоже требовал strict guard на входе. Это подтверждённый typed/runtime
validation defect, не наблюдавшаяся HTTP утечка. Предыдущие успешные проверки не
покрывали эти формы. Исходный repro сохранён вне репозитория с synthetic значениями.

## Минимальная коррекция
Изменены только три production-файла: stories/metadata.ts, doings/state.ts,
hard/metadata.ts. Все state fields требуют typeof string и точный allowlist.
Никаких String/coercion; custom/throwing toString не вызывается.
Stories timed shape определяется strict equality после enum guard.
Тот же private guard проверяет обе стороны follows и boolean read/action helpers
(canReadQuestion, completeDoing, canAdvanceDoing), чтобы unsafe runtime cast не
пропускал malformed enums. Публичные TypeScript signatures остаются прежними.
Это не full-record revalidation всех typed helpers и не новая scope/auth authority.
Sorting helpers остаются presentation operations. Валидные версии, переходы,
согласие/отказ, роли, текстовая политика и удаления не меняются.

## Проверка
Исходные шесть audit cases на corrected source: accepted=false у всех;
оба Hard recipientCanRead=false. Зеркальные API/mobile regressions проверяют
массивы по всем enum значениям, objects/boxed strings/throwing conversion,
boolean/null/numbers и легальные states/transitions. Focused и exact FULL evidence
добавляются после завершения; независимая приёмка обязательна.

Никаких новых функций, зависимостей, миграций, permission changes или GitHub writes.
Native/device/production/E2EE этим исправлением не проверяются и не принимаются.

## Exact acceptance
Source `22ceb7a8c554c4a6dc9058b8b6ef4daa165a9bfa`, tree
`97a2f5fc9e6bbe8a1e22df1f4f38bbf8bd65f926`.
Author `/tmp/pairspace-verification-EDddhN/report.json`; independent
`/tmp/pairspace-verification-9Aek7S/report.json`: оба FULL11/11 PASS,
sourceValid=true, clean before/after. API880, mobile3036, PostgreSQL468 PASS,
PG skipped0. Focused mirrored API8/8 и mobile8/8 PASS; исходные6 repro rejected.
Coverage обоих соответствующих steps, порядок S/B/F/L: API
98.64/97.58/99.78/99.48%; mobile95.71/95.39/96.19/97.43%.
Независимый review подтвердил strict guards, fail-closed consumers и сохранение
валидных transitions; scope blockers нет. Документационный checkpoint код не меняет.
Это исправление runtime validation, не доказательство существовавшей HTTP утечки
и не общая приёмка безопасности приложения. Native/device/production/E2EE не
проверялись, legacy Next gate NOT_RUN. GitHub публикация всё ещё ждёт разрешения.
