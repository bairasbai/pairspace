# Synthetic chat recovery

Status: implemented locally; independent acceptance pending. Opt-in loopback only.
No production endpoint, real personal data, background work or persistent draft storage.

## Bounded user path

A verified signed-in user composes a synthetic message. Pressing Send captures an
immutable raw body and draft revision before any asynchronous work. One unresolved
command is allowed at a time. Its ID is allocated only after fresh context discovery.
The existing queue normalizes the captured text (NFC and line endings) deterministically.

- `sending`: context check or request in progress; repeat button taps do nothing.
- `retry`: no verified acknowledgement. The explicit retry sends the same command
  ID and body, even if the composer has since changed. A terminal rejection remains
  an error, never success. Refresh does not retry a send.
- `sent`: a canonical server ACK passed transport validation. It means server
  acceptance, not delivery to or reading by the partner. History failure cannot
  demote it to retry. ACK leaves the current history window unchanged; Latest
  messages explicitly reads newly committed messages. A subsequent deliberate Send
  creates a new command.

The outgoing body remains visible beside its status. The composer is cleared only
when its revision has not changed since command capture. Editing A→B→A therefore
preserves the newly entered A. An unresolved older command must be retried before
sending the edited composer; no silent cancellation or automatic retry occurs.
Local validation errors do not create an outgoing success. The queue's 500-record
limit still applies. Rejected commands can be explicitly retried unchanged; this
slice does not add a discard/rewrite operation for an unresolved command.

## Context and lifecycle

A transient discovery or credential-read exception preserves RAM state only after
this controller has verified a ready session. No POST is made using cached context.
Every explicit retry discovers the current scope again. Initial discovery still
fails closed; invalid/mismatched context, missing cookie and 401/403 clear private
state. A proven account/pair/membership-epoch change clears old commands and drafts.
Stale same-generation auth denials still invalidate; old-generation completions
cannot mutate the replacement session. A superseding refresh before POST leaves
an explicit retry state rather than silently sending.

Logout and connected-screen unmount abort requests and erase controller-owned
history, command and draft state. Unmount does not call external sign-out or delete
SDK credentials; reopening requires explicit sign-in (which does prior-session
cleanup). There is no irreversible disposed latch, so effect replay can set up again.
Queued auth callbacks check their captured generation before any SDK write.
Already-started SDK auth requests cannot be cancelled by this controller; their
external side effects may still complete, although stale results cannot hydrate
the replacement local lifecycle. Do not treat disposal as server revocation.
No old response can clear or populate the new lifecycle.

## Evidence and limits

`__tests__/auth-chat-recovery.test.ts` and `connected-chat-recovery.test.tsx` exercise
controller/React Native renderer paths, RU/EN labels, double taps, edited drafts,
unknown ACK replay, normalization, failures, stale responses and cleanup.
`services/api/tests/postgres/mobile-chat-recovery.integration.mjs` uses official auth,
real loopback HTTP and disposable PostgreSQL. After COMMIT it drops the response,
replays the exact command and verifies one message and one outbox record.
Results live in `evidence/chat-recovery/`.

Not verified: physical iOS/Android devices, native builds, keyboards/network switching,
SecureStore execution, durable drafts after app/process restart, background recovery,
realtime, delivery/read receipts, production deployment or E2EE. Expo export is JS
bundling only. These limitations keep the broader CHAT P0 acceptance gate open.
