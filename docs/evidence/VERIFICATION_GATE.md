# Fail-closed verification gate: протокол приёмки

Baseline published SHA: 248ca54656e504928a2841907171aac6f3dfa7cf.
Equivalent local baseline SHA: 0d956761259cebcfe012f95d23680324209007ed.
Общее дерево: 0eb02a5e7669507b3f2e55a41b65bec1055dc3eb.

Реализован локальный runner; это не пользовательская функция и не доказательство
готовности production. Причина: составная shell-команда после tsc могла вернуть
успешный exit последнего tail/git status, скрыв ошибку проверки.

До frozen commit пройдены 30 adversarial unit tests собственного runner:
statements 97.07%, branches 92.36%, functions 95.34%, lines 100%.
Изменённые после этого profile/docs будут повторно проверены на frozen commit.
Это предварительная проверка, не независимая приёмка и не полный checkpoint.

Проверяемые угрозы: fail затем success, missing binary/cwd, signal/timeout,
закрытые stdio потомков, большой stdout/stderr, сохранение error exit,
отсутствующие required steps, weakened manifest, пустой/поддельный coverage,
dirty/changed source, interruption и RUNNING report, уникальные run directories,
запрет внешних CLI commands/paths и исключение sensitive output из report.

Full checkpoint выполняется после заморозки source. Машинный report создаётся
вне Git и содержит точный tested SHA/tree, before/after tracked manifests и
результаты каждого шага. Итог и artifact checksum передаются отдельно reviewer;
этот документ намеренно не утверждает результат ещё не выполненного full run.

Не проверено этим инструментом: legacy Next build/typecheck, native iOS/Android,
двухустройственный E2E, production инфраструктура, E2EE, независимый security audit.

Промежуточные full runs LBfblT (475ab73) и 73C5B6 (0be0451) исключены
из acceptance: source менялся после reviewer findings. LBfblT также честно
зафиксировал PG/export FAIL из-за symlink node_modules. Dependencies физически
скопированы из baseline без install. PG package-local guard проходит; Expo
preflight с двумя workers экспортировал обе платформы после exit137 без лимита.
Reviewer дополнительно проверил repeated interruption и hidden dirty Git flags;
исправления требуют нового полного запуска после окончательной заморозки.
