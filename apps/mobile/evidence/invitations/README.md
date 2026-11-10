# Synthetic invitation client verification

2026-11-10. Source base: 0814b0f88c0623f23559ea0c21606a1371ab6e3b.
Status: implementation verified locally; independent acceptance pending.
Logs are generated command output, using synthetic fixtures only; trailing whitespace is normalized.

Passed against the final implementation:
- Mobile strict TypeScript and ESLint.
- Mobile Jest: 24 suites, 858 tests. Global statements/branches/functions/lines:
  97.40 / 97.26 / 98.04 / 97.89%. Invitation transport, controller and panel:
  100% on all four metrics. Existing global thresholds and unimported files retained.
- API strict TypeScript and ESLint; PostgreSQL fixture syntax/lint check.
- API Vitest: 24 files, 175 tests; 99.78 / 99.70 / 100 / 99.85% coverage.
- Safety guards: 8 tests.
- Disposable real PostgreSQL: 85 integration groups. Actual mobile controller,
  official Better Auth fixture cookies, loopback HTTP, owner/recipient/outsider,
  explicit issue/preview/consent/accept, epoch 2 and bidirectional chat.
  Lost issue/revoke/accept acknowledgements, exact accept replay without preview,
  cookie changes, late responses and logout are included.
- Normal iOS/Android Metro/Hermes JS exports.
- Auth-import iOS/Android exports: temporary main `auth-import-verification.ts`
  imported/exported `createSyntheticRuntime` and registered a null component.
  No runtime configuration or request. package.json restored and entry removed.
- `git diff --check`; no new handwritten file exceeds 600 lines.
  Existing 640-line audit.json is machine-generated historical evidence.

The owner token is non-selectable; there is no copy/share/delivery action. Input,
consent and pending commands remain RAM-only. No dependencies or migrations changed.

Not run / not claimed: native iOS/Android build or device UI/accessibility checks,
real SecureStore/networking, two-device testing, background lifecycle acceptance,
production signup/delivery/deployment, independent security or product acceptance.
Exports and React component tests do not replace these gates. Existing dependency
security findings remain unresolved; this is not a clean audit claim.
