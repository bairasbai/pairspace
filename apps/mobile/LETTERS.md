# Synthetic immediate letters

Status: implemented for synthetic loopback tests; independent acceptance pending.
No production, native-device or real private-content readiness is claimed.

The existing injected `SessionController` exposes `letters` actions. The connected
Chat panel contains a separate private composer, explicit send-now button, explicit
partner-list button and individual open/close controls. Default offline App and
Showcase demo do not invoke this path. Central-heart care signaling is unchanged.

Drafts and unresolved immutable `{clientId,body}` commands exist only in the current
app session's RAM. Navigation between tabs preserves this controller state. Logout,
disposal and identity/pair/epoch invalidation clear drafts, pending commands, lists
and opened content. There is no persistent plaintext queue, autosave or draft API.
The sender's draft is never sent by typing, listing or opening.

Send normalizes the shared message-text policy (NFC, LF, maximum 8000 Unicode code
points). An unknown acknowledgement retains the original ID and normalized body;
retry cannot substitute edited text. New draft edits survive the previous send's
acknowledgement. A confirmed send means available on the server, never delivered or
read. Server-provided text is rendered as literal React Native Text, not HTML.

Before every explicit operation the controller revalidates session context and the
cookie snapshot. It rechecks cookie and generation after response and body decoding.
Scope changes discard late responses. Close cancels an outstanding open locally so
its delayed body cannot reappear; it does not cancel an unresolved send.

API: POST `/v1/couples/:id/letters`, with `client_letter_id`, `membership_epoch`,
`body` and matching `Idempotency-Key`. GET the same route with `membership_epoch`
returns metadata only; GET `/letters/:letterId` with the same scope opens the body.
Only a currently listed letter can be opened from this client. Responses must match
exact metadata fields, current scope, sender/recipient roles and requested ID/body.
The list is a bounded window of up to 30 latest received letters, ordered on server
by `created_at DESC,id DESC`, not a complete archive or pagination/end-of-history
claim. No body/title previews are present in the list response or UI.

This slice has no server drafts, scheduling/sealing/release, read receipts, replies,
editing/deletion, push or E2EE. These remain future independently specified work.
