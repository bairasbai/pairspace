# Карта проекта

## Текущее дерево ccbe5df
- app/page.tsx, app/globals.css: интерактивный Next.js концепт Kimi «Рядом».
- lib/dates.ts, lib/text.ts, lib/separations.ts: нейтральная логика из Tan Ata и её адаптация.
- tests/domain.test.ts: девять проверок доменной логики.
- public/: ресурсы веб-концепта; лицензии активов проверяются до коммерческого релиза.

## Нормативные документы
- AGENTS.md: правила работы и независимой приёмки.
- Architecture.md: целевая архитектура и границы модулей.
- SECURITY.md: угрозы, приватность, требования до запуска.
- design.md: визуальная система, сердце и мобильная навигация.
- Memory.md: принятые решения и фактический статус, без персональных данных.
- docs/PRODUCT.md: продукт и набор сценариев.
- docs/SCENARIOS.md: проверяемые пользовательские сценарии.
- docs/TAN_ATA_MAP.md: перенос возможностей без исходной однопарной модели.
- docs/CHAT.md: отдельная спецификация общения.
- docs/DATA_MODEL.md: данные и серверные контракты.
- docs/QUALITY.md: проверки и порог покрытия.
- docs/ROADMAP.md: последовательность реализации и exit gates.
- docs/DECISIONS.md: решения и нерешённые вопросы.
- docs/RESEARCH.md: доказательства и ограничения исследования.
- docs/FINANCE.md: общий бюджет, не банковский счёт.
- docs/FOUNDATION.md: происхождение уже перенесённого кода.

Файлы регистрозависимы. Не создавать вторые Architecture/architecture или Memory/MEMORY.
Исторический docs/ARCHITECTURE.md ведёт к корневому Architecture.md.

## Мобильный preview, отдельная реализационная ветка
`apps/mobile`: самостоятельный Expo package, RU/EN, 4 вкладки, центральное сердце и RAM-черновик.
Детали и ограничения в `apps/mobile/README.md`. Сетевые возможности ещё не реализованы.

`apps/mobile/src/chat`: pure local outgoing-queue state machine and Unicode text validation.
Not wired into UI or a server; boundary and capacity constraints in its README.

`packages/domain/chat/text.ts`: shared pure Unicode normalization, used by mobile and API.
`services/api`: SQL-backed send/history/close use cases, migration and PGlite integration tests.
In-process HTTP handler with mandatory injected verifier; no listener or actual authentication.
`services/api/TRANSPORT.md` describes the temporary protocol and client transport, not wired into UI.

`services/api/src/auth.ts` + `session.ts`: jose verification and transaction session revalidation.
`services/api/migrations/002_auth.sql`: identity/session mapping; AUTH.md states prototype boundaries.

## UI preview checkpoint (10 November 2026)
- `apps/mobile/src/Showcase.tsx`: warm cream/terracotta demonstration surfaces.
- `apps/mobile/src/showcaseCopy.ts`: RU/EN sample copy and honest feature states.
- `PreviewScreen.tsx`: nested letters/calendar/memories routes with visible and Android back.
- `__tests__/Showcase.test.tsx`: navigation, language, draft retention and hardware-back coverage.
- No backend or persistence connected to these screens; approved image is a direction, not rendered proof.

## Subscription domain checkpoint
`packages/domain/subscription/`: immutable pair price catalogue and pure billing
eligibility. `services/api/tests/subscription.test.ts` covers synthetic boundaries.
See `docs/SUBSCRIPTION_DOMAIN.md`; no purchases, provider integration or UI wiring.

## Инвентаризация Tan Ata
[docs/TAN_ATA_MAP.md](docs/TAN_ATA_MAP.md): полный перечень обнаруженных сценариев,
11 точных режимов разговоров, источники и разделение локальной работы, демо и плана.
Все функции Tan Ata включены в дорожную карту; астрология/нумерология — План P2.
[docs/PRODUCT_BACKLOG.md](docs/PRODUCT_BACKLOG.md): критерии переноса и новые идеи,
с разделением утверждённого объёма, предложений и текущей готовности.

## Kimi styling alignment
See [KIMI_DESIGN_ALIGNMENT](docs/KIMI_DESIGN_ALIGNMENT.md): bounded mobile palette/typography/navigation styling.
Device visual acceptance remains open; no backend features added.
