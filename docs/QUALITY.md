# Качество и независимая приёмка

## Обязательные gates целевого мобильного продукта
1. Format/lint + strict TypeScript без подавления ошибок.
2. Unit: ≥90% statements/branches/functions/lines для всего собственного production-кода.
3. Coverage include охватывает все исходники, даже ни разу не импортированные тестами.
4. Integration: реальная тестовая БД, миграции, authz двух пар, queue/retry, storage ACL.
5. Contract: запросы, ответы и события; версии и backward compatibility.
6. E2E: четыре пользователя/две пары/минимум два устройства, logout, disconnect и revoked membership.
7. iOS и Android: native build, запуск и ключевые пути. JS export недостаточен.
8. RU/EN, accessibility, reduce motion, память/длинная история, слабая сеть.
9. Secret scan, dependency audit, лицензии, независимый security review.
10. Reviewer на точном SHA, без блокирующих замечаний; затем публикация в разрешённом объёме.

## Coverage
Исключаются только автогенерация и внешние зависимости; перечень исключений проверяет reviewer.
UI, adapters, error paths и неиспользуемые файлы нельзя исключать для красивого числа.
Тестовый код не входит в знаменатель production coverage, но должен проходить lint/типизацию.
Порог 90% не доказывает отсутствие багов; особо критичные authz/idempotency paths проверяются полностью.

## Текущее состояние
В ccbe5df есть npm test (9 domain-тестов), npm run typecheck и npm run build.
Coverage-gate, мобильные E2E и серверные тесты ещё не настроены.
В документационной проверке повторно выполнен npm test на Node 24.22.1: 9/9.
Typecheck/build, iOS/Android и весь будущий функционал этой проверкой не подтверждены.

## Отчёт reviewer
SHA и base SHA; список diff; команды/версии; результаты; сценарии и ожидаемые эффекты;
блокирующие/неблокирующие находки; непроверенное; итог «принято в указанном объёме» или «не принято».
После изменений повторить затронутые проверки. Документы можно принять отдельно от продукта.

## Локальный автоматизированный checkpoint
Исторический раздел «Текущее состояние» выше описывает ccbe5df, не текущий scope.
Теперь `npm run verify` запускает фиксированные required этапы API/mobile/domain,
реальный PG и safety, runner coverage и JS export. `npm run verify:plan` показывает
план. `npm run verify:runner` ограничен самим runner и не выдаёт full acceptance.
Все четыре coverage metrics >=90 проверяются tool thresholds и свежим JSON summary.
Report фиксирует точный SHA/tree/file hashes, исходную чистоту и отсутствие изменений.
Подробности: docs/VERIFICATION_RUNNER.md; baseline: docs/evidence/VERIFICATION_GATE.md.
Root Next явно NOT_RUN; native/E2E/production и независимая приёмка остаются отдельными.
