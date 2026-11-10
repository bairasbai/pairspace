# Local outgoing chat state machine

Pure TypeScript; no React, network, storage, clock, randomness, authentication or crypto.
This module is not used by the preview UI yet. It does not make messaging work.

## Boundary
`createQueue(scope)` receives a **trusted application-supplied** user/couple/membership epoch
and a fresh local session incarnation. This is not a credential or authorization decision.
The future server still must verify identity and membership transactionally for every operation.
Never create/rebind scope using an incoming message, URL parameter or unverified JSON.
`login` always clears records and requires a different sessionId, including same-account login.
The caller must generate an unpredictable/fresh ID at the application boundary; no UUID generator is bundled here.

`acknowledge` accepts unknown input and validates relevant fields before touching state.
Other actions are typed internal commands; transport adapters must validate their payloads,
assert the authorized scope, bound input sizes and authenticate canonical deletion events.
JavaScript object getters/proxies are not a supported wire format. Decode plain JSON first.

## Invariants
- NFC and CR/CRLF→LF, 8,000 Unicode codepoints (not UTF-16 units), nonblank, valid surrogate pairs.
- Reuse an existing clientId only for the exact normalized message. Changing text requires a new command ID.
- `queued → sending → accepted`, timeout→queued, permanent rejection→failed, explicit retry→queued.
- Retry keeps clientId and body. Attempts increase only on beginSend; stale failures cannot roll back later attempts/ACK.
- Accepted means **server ACK passed to this core**, not delivered/read and not evidence of real transport.
- ACKs cannot invent unknown records, change sender, reuse another record's serverId/seq or restore deleted text.
- Initial-send ACK reconciliation only; editing, incoming history and pagination are separate future protocols.
- A canonical deletion may arrive before ACK. It sets a terminal content-free tombstone and blocks replay.
- Pause retains drafts and requeues in-flight sends; no sending or ACK application until revalidated resume.
- Revoke/logout clear current records; old callbacks with the prior scope cannot apply to a new session.
- Returned state, scope, arrays and records are frozen; previous snapshots remain unchanged.
- This is logical clearing, **not secure memory erasure**: old JS references may still exist.

## Capacity and ordering
At most 500 records, including accepted entries/tombstones. This deliberately fails closed with
queue_full rather than pruning deduplication history and enabling replay. Long-lived history compaction,
durable deduplication and persistent encrypted storage are not implemented. Do not use as production history.
Array order is enqueue order, not the final server timeline. seq is retained for a later history projection.
A tombstone received before ACK can have seq=null. It must not be rendered as a normal message.
Errors are machine codes without message content. The future UI must translate them via RU/EN dictionaries.

## Not included
Authentication, membership discovery, network transport, delivery/read receipts, receipt_epoch,
message editing, replies, history sync, E2EE, storage, push or UI integration. None is implied by unit coverage.
For receipts later: per-message IDs and receipt epoch, never cumulative public read_seq.

## Verification
49 core test cases added; 58 full mobile tests pass. All executable mobile source (10 runtime files,
plus one type-only file with no executable statements) is in coverage: 100% four metrics for this slice.
Tests cover cross-scope commands, stale callbacks, duplicate IDs/ACK, malformed ACK, tombstone replay,
account switching, revoked membership, retries, Unicode and capacity. Native execution remains unverified.

## Shared normalization update
The implementation now lives in `packages/domain/chat/text.ts`; this directory re-exports it.
NUL is also rejected for PostgreSQL text compatibility. Run mobile tests through `npm test` so
Jest starts at repository root and includes shared source in coverage (59 mobile cases now).

## Transport prototype
`transport.ts` connects this reducer to an explicitly injected Request/Response transport.
It is not wired into UI and does not implement login, credential storage or a production server.
See `services/api/TRANSPORT.md` at the repository root for protocol differences and native-streaming limits.
