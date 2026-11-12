# Connected replies to chat messages

Status: implementation in progress, not accepted. New work from independently accepted
9c64e648f1fb3bc9d79b4589052c80d903d3c48a; no missing later source is claimed restored.

## Scope and compatibility

Explicit reply selection, immutable send/retry target, reply-aware 50-message windows,
and explicit authorized source detail allow returning to an original outside the visible
window. The relationship is a canonical message UUID, never a persisted quote copy.
Both participants can reply to their own or their partner's accessible messages.
No automatic send, recursive reply tree loading, or full-history accumulation.

Old messages/history-window response shapes remain unchanged. New opt-in routes:
POST /chat/replies, GET /chat/reply-window, GET /chat/message-detail.
All routes are couple scoped; reads carry fresh read IDs and check current authority.
A command key cannot be reused between a plain message and a reply, or with a new target.
An exact committed reply replay checks current authority but does not demand that its
original still has live text. It never creates a replacement message or quote.

## Internal tombstone readiness, not product deletion

This stage adds an internal terminal tombstone model to prove read safety when an
original loses its text: its row/identity remain, body becomes NULL, version advances,
and deletion cannot be reversed. New reply-aware reads represent that state explicitly.
Old strict readers omit tombstones; a create replay for a deleted message fails closed
rather than returning historical text. This is intentional compatibility behavior for a
new state that has no user-facing DELETE action in this stage.

Synthetic PostgreSQL transitions test this model. They are not proof of an implemented
owner-authorized deletion API, retention workflow, or production deletion service.
The database cannot infer an end user's identity from an administrator's SQL connection.
Future product deletion must authenticate the original author under the same pair locks.

Mobile clears unavailable/deleted source previews, checks response generations and
nonces, and must not restore observed deleted text from a delayed read or acknowledgement.
Navigation and source detail do not overwrite a newer draft or silently change its target.

## Verification and limitations

Required: focused tests and coverage >=90 in all four dimensions, actual PostgreSQL/HTTP
with two pairs and two accounts, long history/source detail, exact retries, target deletion,
late reads/ACKs, scope changes, full eleven-stage author gate, independent exact-SHA review.
Results will be recorded outside the frozen source; failed runs remain separate.

User edit/delete, delivery/read receipts, realtime, native iOS/Android builds, two-device
E2E, durable encrypted local persistence and production deployment are not implemented
or proven here. The outgoing queue's separate 500-record limit is unchanged.

Observed tombstones use a non-evicting ledger capped at 500 distinct message IDs per
local authentication generation. A 501st tombstone fails closed with an explicit re-login
explanation; it never silently discards a barrier. Ordinary live navigation does not use
this allowance. Unrelated new draft/unknown command buffers are preserved until the
user explicitly logs out; known-deleted text must be scrubbed from visible queue/detail/
selection as well. This is a narrow defensive bound, not a claim that every app cache is bounded.

## Focused author checkpoint (not final acceptance)

Mobile final focused run: 860/860 tests, 43 suites; coverage statements96.91%,
branches93.88%, functions100%, lines98.94%; typecheck/lint PASS. Initial tests passed
but the initial typecheck found a synthetic UI mock missing four new actions; that
failure and its explicit mock correction are preserved separately.

API focused run: 31/31 PASS; coverage statements99.44%, branches97.66%, functions/lines100%;
typecheck/lint PASS. Later formatting and real-lock regression changes still require
exact-source rechecking/full gate.

First combined PostgreSQL/HTTP run: 16/17 PASS, not acceptance. All six connected reply
scenarios passed. One test incorrectly required two concurrent waiters to have the same
direct blocking PID. PostgreSQL can queue tuple-lock waiters transitively, but the failed
run did not capture that graph, so its precise graph is not claimed as proven. The test
is changed to independent sequential reply/detail waits, each requiring an observed
real blocker before crossing session expiry; no sleep-only substitute or weakened
post-lock authorization assertion. The original failure log is retained.

Final focused checkpoint: API32/32 PASS after formatting and unauthenticated-write
regression; typecheck/lint PASS, same coverage above. Corrected combined PostgreSQL/HTTP
17/17 PASS in21.793s, including independently observed reply/detail pair-lock waits,
expired authority after waiting, unchanged writes/outbox, all six connected reply flows
and eight legacy connected history/recovery/controller checks. Full exact-source author
and independent gates are still required; these focused results are not final acceptance.

Deletion protection is observation-based: this slice has no realtime deletion delivery.
A client that has not reread a changed message may still show its earlier live view.
Once an authorized tombstone is observed, stale reads and ACKs must not revive it.

Pre-freeze review corrections: an observed own-message tombstone now scrubs an unchanged
submitted composer immediately, rather than waiting for its delayed ACK; a separately
edited draft remains. New reply wire identifiers also require canonical UUID spelling,
so case aliases cannot bypass terminal-ID knowledge after the old row leaves the window.
These corrections require new focused and full runs; preceding counts remain historical.

After both pre-freeze privacy corrections: mobile862/862 PASS, coverage
96.92/94.05/100/98.94 (statements/branches/functions/lines), typecheck/lint PASS.
Combined real PostgreSQL/HTTP18/18 PASS in21.793s, including immediate composer scrubbing
before held ACK and preservation of a distinct newer draft as separate scenarios.
