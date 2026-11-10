# Blind answers: synthetic bounded contract

One non-sensitive built-in question `small-joy`, catalogue version 1, RU/EN.
Only one round per active pair/epoch, including after completion. This is a slice
limit, not a production quota. Opening is explicit and returns the existing round.
No daily scheduling, automatic refresh, notifications, history, edit/delete/cancel,
new series, AI, advice, psychological scoring or transfer from Tan Ata production.

## Routes
- POST `/v1/couples/:id/blind-round`: command_id, membership_epoch, question_id,
  catalog_version. Creates or opens the sole round.
- GET same route with membership_epoch: current round or null.
- POST `/v1/couples/:id/blind-round/:roundId/answer`: same fields plus answer,
  confirm:true. Immutable after submission; caller explicitly confirms mutual reveal.
- POST requires application/json and matching Idempotency-Key. No query text payloads.

Round projection: id, coupleId, membershipEpoch, questionId, catalogVersion,
ownAnswer, partnerAnswer, revealed. partnerAnswer is null before two submissions;
there is no partner submitted flag, length, time, presence or read receipt.
Own submitted answer can be read on a later authenticated session in the same pair.
Mutation result includes commandId/replay and the CURRENT authorized projection.
A lost ACK retry must reuse the exact immutable command, not create a new one.

## Authorization and storage
Every transaction shares the pair-close lock order and fresh session checks.
Active pair must have exactly the two snapshotted members in the requested epoch.
Before reveal, SQL reads only caller body and submission identities/existence;
partner body is queried only after both submissions have been proven.
Round/answers/receipts are immutable. DB constraints supplement service checks.
All responses are no-store; failures contain generic codes without user content.
No list/history endpoint. No closed-pair or new-pair old-answer access, even on replay.

Drafts remain device RAM, separate from frozen in-flight commands. User may decline
submission indefinitely. After submission answers cannot be changed in this slice.
Server-readable plaintext, not E2EE. No answer logs, analytics, crash payloads, URLs,
notifications or outbox. Tests use synthetic text and temporary PostgreSQL only.
Production retention, deletion, recovery and lifecycle policy remain undecided.
