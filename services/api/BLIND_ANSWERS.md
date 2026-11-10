# Blind answers: synthetic bounded contract

Three built-in neutral questions, catalogue version 1, RU/EN. `small-joy` v1 keeps
its original wording and meaning. Selection is explicit, with no therapy claims.
There is one unfinished round at a time for an active pair/epoch. Completed rounds
remain immutable. A new round requires an explicit confirmed command after both
participants submitted to the current round. No automatic daily rotation.

## Routes and compatibility
- POST `/v1/couples/:id/blind-round`: command_id, membership_epoch, question_id,
  catalog_version. Creates or opens the FIRST `small-joy` v1 round only.
- GET same route with membership_epoch: FIRST round or null, never the latest round.
  Legacy clients cannot silently create or advance to a successor.
- POST `/v1/couples/:id/blind-round/:roundId/answer`: command_id, membership_epoch,
  question_id, catalog_version, answer, confirm:true. Binds to that exact round.
- GET `/v1/couples/:id/blind-rounds?membership_epoch=N`: latest ten metadata rows,
  value `{currentRoundId, rounds:[{id,questionId,catalogVersion}], limit:10}`.
  Newest first by predecessor-chain order. No answer bodies or submission status.
- GET `/v1/couples/:id/blind-rounds/:roundId?membership_epoch=N`: selected round.
- POST `/v1/couples/:id/blind-rounds/next`: command_id, membership_epoch,
  expected_predecessor_round_id, question_id, catalog_version, confirm:true.
  The predecessor must be the current round with both participant submissions.
  A stale predecessor or unfinished round returns 409 round_conflict; refresh
  explicitly rather than silently applying the command to a different predecessor.
- POST requires application/json and matching Idempotency-Key. Strict field sets.

Round projection: id, coupleId, membershipEpoch, questionId, catalogVersion,
ownAnswer, partnerAnswer, revealed. partnerAnswer is null before two submissions;
there is no partner submitted flag, length, time, presence or read receipt.
Own submitted answer can be read on a later authenticated session in the same pair.
Mutation result includes commandId/replay and the authorized projection of the
ORIGINAL command target, which may no longer be current. Replay cannot advance
current selection. A lost ACK retry must reuse the exact immutable command.
Changed question/version, predecessor, round, operation or answer is not a retry.

## Authorization and storage
Every transaction shares the pair-close lock order and fresh session checks.
Active pair must have exactly the two snapshotted members in the requested epoch.
Before reveal, SQL reads only caller body and submission identities/existence;
partner body is queried only after both submissions have been proven.
Round/answers/receipts are immutable. Migration 011 changes constraints and adds
an immutable predecessor reference without rewriting existing rows. SQL uniqueness
and a pair-locking insert guard enforce one initial round and an unbranched chain;
a successor requires the current tip and both exact participant authors.

All responses are no-store; failures contain generic codes without user content.
Metadata history is only a last-ten window, not a retention/deletion/full archive
promise. Explicit selected reads still require current pair authorization, even
for older IDs. No closed-pair or new-pair old-answer access, including replay.

Drafts remain device RAM, separate from frozen in-flight commands. User may decline
submission indefinitely. Answers cannot be edited/deleted/cancelled in this slice.
Server-readable plaintext, not E2EE. No answer logs, analytics, crash payloads, URLs,
notifications, AI or outbox. Tests use synthetic text and temporary PostgreSQL only.
Production retention, deletion, recovery and lifecycle policy remain undecided.
