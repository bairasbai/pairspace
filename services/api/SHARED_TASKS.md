# Shared tasks: synthetic HTTP/SQL contract

This is an independent loopback-only `enableSyntheticSharedTasks:true` opt-in.
No listener or production account/data setup is added. HTTP origin, body limits,
provider verification and no-store responses use the existing composition.

## Commands and reads
- GET `/v1/couples/:coupleId/tasks?membership_epoch=N` returns
  `{ok:true,value:{tasks:[Task],limit:50}}`.
- POST collection: `{command_id,membership_epoch,title}` creates an open v1 task.
- POST `/v1/couples/:coupleId/tasks/:taskId`:
  `{command_id,membership_epoch,operation:'complete'|'reopen',expected_version}`.
- POST requires `Idempotency-Key` equal to command_id and JSON content type.
- Task fields: id, coupleId, creatorId, membershipEpoch, title, state, version,
  createdAt, updatedAt. Title is normalized plain text, not markup.
- Mutation value: `{task,commandId,replay,appliedVersion}`. A replay always reads
  the current task under authorization and the transaction lock. appliedVersion
  names the original change; task.version may be newer. Do not restore old state.

Invalid input is 400, missing authority 401, unavailable scope/resource 403.
409 separates stale_membership, idempotency_conflict and version_conflict.
503 is a generic transient failure without SQL, titles or credential content.
A version conflict is not an instruction to resend with a guessed newer version:
refresh the list and let the member explicitly choose another action.

## Isolation and serialization
Actor comes from session authority. Pair ID and epoch are preconditions, not ACL.
Both reads and mutations reuse the closure lock order: discover historical members,
lock domain users in UUID order, check session, lock pair, reread membership and
recheck session after waits. Exactly two active members and active pair are needed.
The actor user lock also serializes command IDs across historical pair scopes.

A receipt is immutable and keyed by actor plus command ID. Create binds normalized
text/pair/epoch. State changes bind task, operation, expected version and pair/epoch.
A changed command fails; a replay cannot mutate a newer task version. If the pair
is closed, neither list nor replay grants access. New pair state is isolated.
Title, creator, identity, creation time and scope are immutable in the database.
State changes increase version by one. No deletion endpoint exists.

## Bounded window and limits
Newest 50 by created_at DESC then UUID DESC, stable under complete/reopen.
SQL constrains timestamps to millisecond precision, matching API ISO strings.
updatedAt never moves backwards, even when the server wall clock does.
The response does not imply archive completeness. There is no cursor or pagination.
Title: NFC, trim/collapse whitespace, 1–200 Unicode code points, at most 800 UTF-8
bytes. Control/format/surrogate characters are not accepted after normalization.
There is no title in URL, outbox, analytics, notification payload or application log.

No assignment, deadlines, title editing, deletion, push, realtime or archive policy.
Server storage is plaintext; E2EE and production retention remain open decisions.
See `docs/SHARED_TASKS_EVIDENCE.md` for test outcomes and unverified native gates.
