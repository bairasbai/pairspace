# Изолированный Better Auth spike

Дата: 2026-11-10. Статус: исходный bounded spike принят независимым reviewer в пределах handler tests, typecheck и JS exports. После замечания исправлена обработка npm audit; **эта ревизия ожидает повторного независимого review**. Native/production готовность не принята.
Всё создано в отдельном cloud scratch `better-auth-spike`. Исходный Pairspace прочитан, но этим spike не изменён. Нет push, deployment, реальных пользователей или внешних аккаунтов.

## Результат

Практическая интеграция **Better Auth 1.7.19 + @better-auth/expo 1.7.19** работает в проверенном объёме. Оба пакета получены из официального npm registry, поле license MIT, repository указывает на better-auth/better-auth. Registry stable latest на момент проверки: 1.7.19. Оба выше заданного security floor 1.7.16. Это не утверждение об отсутствии всех уязвимостей.

Источники:
- https://www.npmjs.com/package/better-auth/v/1.7.19
- https://www.npmjs.com/package/@better-auth/expo/v/1.7.19
- https://github.com/better-auth/better-auth/security/advisories/GHSA-4wq4-2ppv-q3hg
- https://www.better-auth.com/docs/integrations/expo

Registry metadata сохранены в evidence/*registry.json. Lockfile фиксирует версии и integrity; все resolved tarball URL ведут в registry.npmjs.org. Security floor передан в задании; попытка получить advisory напрямую через GitHub API не удалась (см. evidence/advisory-fetch-error.txt), поэтому полное содержимое advisory здесь не независимо подтверждено.

## Прошло

`npm test`: 5 тестовых групп (3 auth integration + 2 audit-script regression),, реальный Better Auth handler и официальный Expo server plugin, без сетевого сервера и моков auth. Одноразовый SQL SQLite `:memory:` на Node 24.22.1; официальные migrations API. Secret случайный, существует только в памяти процесса.

- Реальный email/password signup, выдача подписанного session cookie, getSession.
- В БД пароль не хранится как исходная строка; пароль хеширует Better Auth.
- Неверный пароль отклонён, повторный signin создаёт другую сессию.
- Пользователь B не может отозвать сессию A.
- A отзывает вторую сессию A; повтор getSession для неё возвращает null, первая остаётся рабочей.
- Signout отзывает первую сессию; её SQL rows отсутствуют.
- Поддельный cookie, expired session и удалённая из БД session не аутентифицируются.
- Неподдерживаемый bearer/JWT не служит fallback.
- Недоверенный обычный и Expo origin отклоняется, trusted native scheme принимается.
- Expo authorization proxy не перенаправляет на непроверенные HTTPS/javascript/fragment destinations и не устанавливает cookies для них. Это ограниченный негативный тест, не полный OAuth security audit.

`npm run typecheck`: strict TypeScript прошёл для официального React client + expoClient + SecureStore и signup/signin/getSession/getCookie/revokeSession/signout API.

`npm run export`: Metro/Hermes iOS и Android JS exports прошли на **Expo 58.0.23 / React Native 0.88.1 / React 19.3.0**. Expo-модули зафиксированы по bundledNativeModules этой версии. Native client импортирует реальный expoClient и SecureStore; экран не вызывает backend. Test URL зарезервирован `auth.example.invalid`.

## Аудит зависимостей

`npm audit`: 5 moderate, 0 high, 0 critical. Узлы: expo, @expo/cli, @expo/fingerprint, glob, minimatch. Полные findings и цепочки: evidence/audit.json. В этом выводе нет Better Auth findings, но это не security clearance. Не выполнялся auto-fix или downgrade Expo. Политика зависимостей и remediation остаются release gate.

## Исправление после независимого review

Замечание: прежний verify.sh проглатывал не только findings, но и operational failures npm audit. Теперь scripts/audit.sh допускает только exit 0/1 с валидным JSON auditReportVersion=2, отсутствием error, корректной metadata и согласованными vulnerability counts. Network failure, повреждённый/пустой JSON, отсутствующая metadata, некорректные counts, operational exit >1 и несогласованный exit/status делают проверку красной.

Regression tests запускают настоящий shell helper + validator с disposable npm stub, не обращаясь к сети. Покрыты clean report, report с findings и 8 failure cases. Реальный audit повторён через новый helper: 5 moderate findings, валидированный exit 1. Auto-fix по-прежнему не выполняется. Исходный архив pairspace-better-auth-spike-20261110.tar.gz сохранён как checkpoint до исправления; текущая ревизия упакована отдельно.

## Единственный источник auth/session

В spike authoritative источник — **Better Auth SQL user/account/session**, cookie cache отключён; на клиенте также disableCache:true. Никакого параллельного auth_sessions, самодельного JWT, собственных refresh tokens или fallback identity здесь нет.

Для переноса в продукт нельзя просто пристыковать текущий jose + auth_sessions verifier как второй источник истины. Нужно отдельно спроектировать:
1. Стабильное сопоставление Better Auth user ID с domain user ID (не принимать ID из body; текущие UUID-инварианты надо учесть).
2. Передачу проверенного principal из Better Auth server getSession в domain API.
3. Финальную transactional проверку активной **той же authoritative** сессии совместно с user/couple membership и epoch. Отдельная копия session без гарантированной синхронизации неприемлема.
4. Согласованный lock order и revocation race policy на PostgreSQL; SQLite spike не доказывает блокировки PostgreSQL.
5. Migration/backfill и замену прототипа только после review; здесь они не выполнялись.

## Не запускалось / не доказано

- Native builds, simulator или physical iOS/Android, SecureStore persistence, reinstall/backup semantics, two-device logout/revocation.
- End-to-end Expo client → сетевой backend. Handler tests и client type/export tests разделены.
- OAuth/social login, redirect/deep-link interruption, browser session, refresh/reuse abuse, MFA, recovery, verification email, delivery/rate limits.
- PostgreSQL integration, concurrent revoke vs domain transaction, account deletion, migration/backfill.
- Production HTTPS, reverse proxy, cookie configuration, CORS/CSRF deployment policy, secret rotation, observability, penetration testing.
- Full application tests/coverage: product application не менялся. Spike — integration evidence, не замена обязательного product coverage ≥90%.

## Воспроизведение

Требуется Node 24.22.1 (используется node:sqlite), npm 11.9.0 и доступ к официальному npm registry.

Запустить `bash verify.sh` из каталога spike. Скрипт использует `npm ci --ignore-scripts`, затем tests, typecheck, оба exports и сохраняет audit отдельно. HOME/npm cache направлены в disposable каталоги spike, Expo telemetry отключена. Первый export с default HOME упал из-за недоступной `/home/agent/.expo`; повтор с локальным HOME прошёл. Это ограничение scratch, не incompatibility Expo.

Файлы проверки: evidence/test.log, typecheck.log, export.log, audit.json, dependencies.txt, registry-lock-check.txt. Точные source/lock хеши: evidence/SHA256SUMS. Собственные рукописные файлы короче 600 строк; lockfile машинный. Ни один secret, session token или plaintext пароль реального пользователя не сохранён. Строки паролей в тестах исключительно синтетические.
