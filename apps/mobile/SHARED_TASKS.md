# Shared tasks: synthetic connected mobile slice

Status: implementation, not independent acceptance or native-device verification.
The default offline Kimi showcase is unchanged. Injecting the existing synthetic
session controller exposes a RU/EN shared-task panel in connected Chat; no second
session/controller is constructed. Both active partners can create, complete and
reopen a task. No editing, deletion, assignment, due date, archive or push feature.

## State and privacy

- `tasks.ts` owns RAM-only draft, immutable pending command, bounded list and status.
  Titles never enter URLs, logs, device persistence, notifications or analytics.
  Explicit creation stores the normalized title on the server.
- Draft typing does not call the server. Create sends normalized title explicitly.
  A later edited draft cannot replace the original retry payload or be erased by
  an older acknowledgement. Clear draft does not undo an already submitted command.
- One mutation can be unresolved at a time. A timeout/unknown ACK keeps the same
  operation, target, expected version, command ID and original title. Retry is a
  distinct action. Refresh can read current data without discarding that command.
- Version/idempotency conflicts discard the rejected command and require an explicit
  successful refresh before any new mutation. No automatic toggle or overwrite.
- A replay returns current canonical task state, not its historical receipt state.
  The UI says “command recorded” and displays the returned version/state. Completing
  v1→v2, partner reopening v2→v3, then retrying the original completion displays open v3.
- Each request rechecks session context and cookie identity. Scope/epoch/session
  changes, logout, disposal and pair leave scrub tasks, draft and pending command.
  Late cookie/context/body/network responses are ignored after invalidation.
- Clear draft cancels an active list request logically, preventing a late refresh
  from repopulating it; submitted saves retain their reconciliation semantics.

## Bounded display

GET returns at most 50 newest-created tasks ordered by immutable createdAt DESC,
id DESC. UI states that this is not the full archive. Mutation ACKs upsert a current
task and retain the cap; they do not assert that the entire list was refreshed.
There is no background polling or offline queue.

## Verification

`npm test --prefix apps/mobile` runs controller, validator, RU/EN panel and connected
session tests, including conflicting partners, unknown ACK, edited/cancelled draft,
late response, session replacement and malformed/foreign/oversized responses.
Global coverage includes unimported production and shared-domain files.

TypeScript and lint are separate checks. `npm run export --prefix apps/mobile`
bundles iOS/Android JavaScript only; it is not a native build or two-device test.
Real PostgreSQL mobile integration is in
`services/api/tests/postgres/mobile-shared-tasks.integration.mjs`.
Exact aggregate results and remaining limitations belong to
`docs/SHARED_TASKS_EVIDENCE.md`.
