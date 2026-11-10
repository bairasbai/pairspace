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

## Мобильные синтетические приглашения
`apps/mobile/src/auth/InvitationPanel.tsx`, `invitations-controller.ts` и `invitations.ts`:
явный выпуск/метаданные/условный отзыв; ручной токен, предпросмотр и отдельное согласие.
Контракт: [PAIR_INVITATIONS](apps/mobile/PAIR_INVITATIONS.md).
Реальный loopback/PG harness: `services/api/tests/postgres/mobile-invitations.integration.mjs`.
Доказательства: `apps/mobile/evidence/invitations/`; независимая приёмка ожидается.

## Восстановление синтетической отправки
`apps/mobile/src/auth/controller.ts`: immutable command, revision черновика,
явный retry и очистка при logout/unmount/смене scope; RU/EN панель показывает ACK.
Контракт: [CHAT_RECOVERY](apps/mobile/CHAT_RECOVERY.md).
Тесты: `auth-chat-recovery.test.ts`, `connected-chat-recovery.test.tsx`,
`services/api/tests/postgres/mobile-chat-recovery.integration.mjs`.
Доказательства: `apps/mobile/evidence/chat-recovery/`; native-приёмка не выполнена.

## Synthetic draft lifecycle contract
- `apps/mobile/src/chat/draftContract.ts`: bounded injected-store experiment, not wired to App.
- `apps/mobile/src/chat/DRAFT_CONTRACT.md`: binding, deletion/send ordering and native blockers.
- `apps/mobile/__tests__/draft-contract.test.ts`: failure/race/restart harness with real send adapter.
- `apps/mobile/evidence/draft-contract/`: local verification; independent acceptance separate.

## 2026-11-10 — ограниченное окно истории чата
- apps/mobile/src/chat/history.ts: bounded union, дедупликация и отказ при конфликте.
- apps/mobile/src/auth/controller.ts: loadOlder, свежий контекст, cursor и latest-50 reset.
- apps/mobile/CHAT_HISTORY.md: RU/EN путь, лимит 200, гонки и ограничения проверки.
- services/api/tests/postgres/mobile-chat-history.integration.mjs: >50 сообщений,
  разреженные seq, две пары, права и настоящий PostgreSQL.

## 2026-11-10 — отдельный сигнал заботы (synthetic)
- `services/api/CARE_SIGNALS.md`: контракт фиксированного «Думаю о тебе»,
  свежая SQL-авторизация, идемпотентность, cooldown и окно явного чтения.
- `apps/mobile/CARE_SIGNALS.md`: opt-in connected UI, повтор после неизвестного ACK,
  RU/EN и очистка области; исходный offline preview не подключён к сети.
- `docs/CARE_SIGNAL_EVIDENCE.md`: выполненные проверки и оставшиеся gates.

## 2026-11-10 — центральное сердце в synthetic-режиме
- `apps/mobile/src/auth/ConnectedNavigation.tsx`: общая кнопка и RU/EN статусы care store.
- `apps/mobile/src/auth/useControllerOwner.ts`: App владеет controller между вкладками.
- `apps/mobile/__tests__/central-heart.test.tsx`: интеграция с настоящим controller.
- [CENTRAL_HEART_EVIDENCE](docs/CENTRAL_HEART_EVIDENCE.md): проверки и открытые gates.

## 2026-11-10 — немедленные synthetic-письма
- `services/api/LETTERS.md`: send-now, неизменяемая команда, входящие метаданные
  и отдельное авторизованное открытие тела; миграция `006_letters.sql`.
- `apps/mobile/LETTERS.md`: приватный RAM-черновик, RU/EN и явные сетевые действия.
- `docs/LETTERS_EVIDENCE.md`: проверки и ограничения; независимая приёмка отдельно.

## 2026-11-10 — scheduled synthetic-письма
- `packages/domain/letters/schedule.ts`: строгий offset ISO + IANA контракт без угадывания DST.
- `services/api/migrations/007_scheduled_letters.sql`: nullable-поля, старые письма немедленные.
- `services/api/LETTERS.md`: серверный release gate и неизменяемое расписание.
- `docs/SCHEDULED_LETTERS_EVIDENCE.md`: результаты, frozen source и ограничения проверки.

## Добровольное завершение synthetic-пары
- `services/api/src/pair-close.ts`: общий порядок блокировок и закрытие, включая legacy entry.
- `services/api/src/pair-leave.ts`, `pair-leave-http.ts`: scoped immutable command и replay.
- `services/api/migrations/008_pair_leave.sql`: receipt и отложенный запрет активных членств закрытой пары.
- `apps/mobile/src/auth/leave.ts`, `LeavePanel.tsx`: RU/EN подтверждение, scrub, pending/retry/closed.
- `docs/PAIR_LEAVE_EVIDENCE.md`: проверки, ограничения, synthetic-решения против открытых owner ADR.

## Общие задачи активной synthetic-пары
- `packages/domain/tasks/title.ts`: независимая нормализация ограниченного заголовка.
- `services/api/src/shared-tasks.ts`, `shared-tasks-http.ts`: create/list/complete/reopen,
  optimistic version и immutable receipt; миграция `009_shared_tasks.sql`.
- `apps/mobile/src/auth/tasks.ts`, `TasksPanel.tsx`: общий connected controller,
  RAM-черновик, неизменяемый retry, RU/EN и явное обновление при конфликте.
- `docs/SHARED_TASKS_EVIDENCE.md`: проверки и открытые gates.
