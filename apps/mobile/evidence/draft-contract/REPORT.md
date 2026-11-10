# Local synthetic draft contract verification

Base local `2ae0cb5ffd25e15a7f2b63d8063117fac5a69bbe`, tree
`5e63e0262b4d89d3a6e574b821cba9428d029474`, matches published base tree.
Independent acceptance pending; author does not accept own work.

## Passed
- Full mobile Jest suite: 927 tests in 27 suites.
- All included mobile/domain runtime: statements 97.59%, branches 97.50%,
  functions 98.25%, lines 98.02%. Existing named coverage scope unchanged.
- New draftContract.ts: 100% statements/branches/functions/lines.
- Mobile TypeScript and ESLint; root domain tests: 9 passed.
- Single envelope normalization/UTF8 limit, exact binding and unknown-data rejection.
- Edit/read/write races, live authorization denial, close/drain, exclusive owner,
  failed purge/no-op write, terminal consumption and sanitized storage failures.
- Synthetic restart harness with real queue/transport and injected unknown-ACK
  request: draft removed before send, restart cannot restore it as a new command.
- Failed consume does not invoke send. Old close cannot purge a new owner.

Logs produced by package scripts, trailing whitespace removed for diff hygiene.
No credentials, personal data, external upload, deployment or production connection.
No dependency changes. Work performed in separate checkout preserving original.

## Not run / not claimed
API/postgres suites not rerun: no API/domain/transport changes in this slice.
Expo exports, native builds and device tests not run. No UI/runtime wiring changed;
a standalone synthetic contract is not shipped persistence or restart acceptance.
The fake store models settled linearizable operations, not native encrypted storage
or power-loss durability. App retains memory-only drafts. Live verifier is a caller
boundary, not an authentication implementation. Durable logout/install policy,
real native adapter and full controller integration remain blockers documented in
`../../src/chat/DRAFT_CONTRACT.md`. No automatic replay or durable outbox provided.
