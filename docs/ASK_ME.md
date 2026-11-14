# Ask me: bounded shared question/answer candidate

Status: implementing, not accepted. Base accepted `e469600`.
Source Tan Ata snapshot `4822e213e991f6e8c0177751e0fd6626b1f237bc`, read-only:
`app/talk/ask/page.tsx`, `components/AskBoard.tsx`, `lib/talk.ts` askSomething,
allAsks and answerAsk. Source has authored questions, one reply from the other
person, pending-first ordering and visible history. This is not blind answers.
No original personal texts/configuration copied; implementation is independent.

## Shared publication and rights
Both current active members of the exact pair epoch can read all remaining shared
question/answer text and safe states. Any member can explicitly publish a question;
the server derives the recipient as the other current member, not a caller-selected
user. Only that recipient can answer once or voluntarily skip without explaining.
No time limit, reminders, penalties or implication that an answer is owed.
Question and answer are immutable after publication. To correct a question, remove
own text and explicitly publish another, not silently rewrite a past conversation.

Question and answer each contain1–2000 Unicode code points: NFC, trimmed, CRLF→LF,
internal paragraphs preserved; invalid controls/lone surrogates rejected. Unsaved
composer/answer text remains separate RAM input until explicit publication.

## State table and split removal
Stable identity: id,coupleId,authorId,recipientId,membershipEpoch,sequence,createdAt.
Aggregate version begins1; every successful new state transition increments once.
Question state: active with question text, or removed without question text.
Response state:
- waiting: question must be active; no answer/answeredAt.
- answered: answer text and immutable answeredAt, question active or removed.
- skipped: no answer/answeredAt, question active or removed; terminal recipient choice.
- withdrawn: question removed, no answer/answeredAt; asker ended a pending question.
- answer_removed: no answer text, original answeredAt and recipient attribution remain;
  question active or removed; terminal, cannot answer again.
Answer timestamps are logical monotonic record metadata: max(trusted server time,
question creation time), not proof of precise physical time or a read receipt. SQL
requires answeredAt >= createdAt; a clock rollback cannot poison future client reads.

Only asker can remove an active question. If waiting, response becomes withdrawn;
otherwise answered/skipped/answer_removed is preserved. In particular the other's
answer remains visible under a question-removed label. Confirmation explicitly says
that removing your question does not delete their answer. Only responder can remove
an answered answer; question remains unless already removed. Its confirmation says
which text remains and that replacement/restore is unavailable. Skip is separately
confirmed as a terminal voluntary choice, never implied by asker withdrawal.
No fresh operation is a no-op: invalid terminal state yields version conflict;
only a matching immutable command replay returns the current canonical result.
Logical current-body removal cannot erase previously read copies or DB backups.

## Concurrency and bounded client
CAS serializes answer/skip/withdraw races. Commands have immutable metadata/fingerprint
receipts, no receipt plaintext or fingerprint logging. Retry after later removal
returns current tombstone state, never old text or a recreated answer. Authoritative
session/pair/epoch checks run after contended locks; late receipt failure rolls back.

Complete snapshot is bounded100 lifetime questions INCLUDING removed entries, ordered
waiting first then descending creation sequence. Explicit synthetic technical cap and
remaining capacity, not tariff/product-ready scale. At capacity answer, skip and own
removals still work. History is reachable, not a hidden first-page-only subset.
Only full GET sets snapshot checkedAt; mutation ACK updates one canonical record,
not freshness of others. Known identity/version/terminal fences reject resurrection.
GET checkedAt remains its actual server clock value, never raised to entity timestamps.
A rolled-back or inconsistent snapshot fails closed, retains known entries/newer RAM
and shows retry/error; a later valid snapshot can recover. This is distinct from the
logical monotonic answer timestamp and does not silently rewrite snapshot freshness.
Newer RAM survives unknown ACK retry. If target becomes terminal/changed, untouched
old draft may clear; genuinely newer input is explicitly unsaved/stale with actions
disabled and cancel guidance. Session changes clear actor-scoped private state.

## Limits and verification
No edit/re-answer/restore, hidden answers, receipts, push/provider/native permissions,
realtime, durable offline queue, AI, production deployment or physical erasure claim.
Separate default-off synthetic API opt-in; existing modules unchanged.
Required tests: A/B/former/revoked; cannot self-answer/delete other's text; all valid
and forbidden state combinations; metadata erasure; replay after skip/removal; CAS
races/rollback/real held-lock authorization; cap; lost ACK/newer RAM/late snapshots;
RU/EN UI confirmations. Real PG uses bounded fixtures, no added minute waits.
Early independent code review before freeze, then exact author/independent FULL11.
Current outer budgets API450s and PG1110s/runner1140s; inner guards/floors unchanged.
