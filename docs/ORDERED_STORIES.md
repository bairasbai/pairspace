# Ordered stories: bounded synthetic candidate

Status: implemented synthetic candidate; independent contract review passed; not accepted.
Base: accepted `316978a22e592d3570868b3aee72d5c6a30a9c69` (Library v17).

## Source and difference from Ask

Read-only Tan Ata commit `4822e213e991f6e8c0177751e0fd6626b1f237bc`:
`app/talk/stories/page.tsx`, `components/TalkParts.tsx` StoryOrder/StoryTell,
`app/talk/actions.ts` orderTopic/tell, `lib/talk.ts` allStories/orderStory/tellStory.
The requester publishes a topic; the other person may publish one long narrative.
Waiting orders sort first. The page and catalogue explicitly reject a deadline;
the old StoryTell placeholder mentioning a week contradicts them and is not copied.
No minimum wait, weekly deadline, obligation, reminder or penalty is introduced.
No source personal text, fixed identities, nudge/provider integration or code is copied.

Existing Ask is a question/one-answer exchange, each text <=2000 code points, with
answers inline in the complete snapshot. It already has voluntary skip and no deadline.
Those properties therefore are not claimed as novel story behavior.
This slice has a short topic (1–300), a long-form narrative (1–8000), a separate
long-form composer and explicit reader. History and mutation acknowledgements carry
metadata/topic only, never the narrative body. An explicit authenticated GET reads
one published story; closing the reader clears that body from RAM. This is an
independent topic-to-narrative workflow, not an Ask alias, copied questions or AI text.
Metadata-only lists are a bounded adaptation, not a secrecy/reveal condition:
both current members can explicitly read a published story immediately and repeatedly.

## Voluntary publication, authorship and removal

The exact active pair epoch has two members. Either may explicitly request a topic;
the server derives the other member as storyteller. Only that storyteller can tell
once or decline without a reason. The requester cannot answer their own order.
Topics and published stories are immutable. Drafts are independent RAM inputs and
are never uploaded before explicit publication. No edit, restore or second telling.
Normalization: NFC, CRLF to LF, trimmed, preserve internal paragraphs; reject controls
other than LF and lone surrogates. Limits count Unicode code points, not UTF-16 units.

Identity: id/coupleId/topicAuthorId/storyAuthorId/membershipEpoch/sequence/createdAt.
Version starts at1 and increments exactly once for every fresh transition.
Topic state: active (topic present) or removed (topic absent).
Story state and legal combinations:
- waiting: active topic, no toldAt/body.
- told: active/removed topic; toldAt remains, body exists in storage/detail only.
- declined: active/removed topic; no toldAt/body; terminal storyteller choice.
- withdrawn: removed topic, no toldAt/body; requester withdrew while waiting.
- story_removed: active/removed topic; original toldAt and storyteller attribution
  remain, body is null/absent; terminal, cannot tell again.

Only the requester removes their topic. While waiting this withdraws the order;
after tell/decline/removal it preserves that state and the other author's story.
Only the storyteller removes a told body. The requester's remaining topic stays.
Confirmations explicitly explain what remains and that replacement is unavailable.
Decline has a separate confirmation and is never inferred from requester withdrawal.
No fresh mutation is a successful no-op. Matching immutable retries alone may replay.
Removal hides current server text; it cannot erase previously read copies or backups.
Metadata toldAt is max(trusted server time,createdAt), not a read receipt or deadline.

## Protocol and concurrency

Independent default-off loopback-only API opt-in and connected synthetic mobile UI.
`GET/POST /v1/couples/:couple/stories`: full metadata list / create topic.
`POST :id/story`: tell; `DELETE :id/story`: remove own body.
`POST :id/decline`: decline; `DELETE :id/topic`: remove own topic.
`GET :id/text?membership_epoch=...`: canonical current metadata and body only if told.
Order payload: membership_epoch,command_id,topic. Tell payload adds expected_version
and body instead of topic. Other mutations carry membership_epoch,command_id and
expected_version. GET accepts only membership_epoch; actors are never request fields.
All responses have exactly `{ok:true,value}` or `{ok:false,error}` at the root.
Metadata has exactly the stable identity fields above, version, topicState and
storyState, plus topic iff active and toldAt iff told/story_removed; never body.
Wire values and maximum read sizes:
- List: exactly stories (metadata[]),checkedAt,capacity:100,used; <=256KiB.
- Mutation ACK: exactly story (metadata),commandId,replay; <=16KiB.
- Detail: exactly story (metadata),checkedAt and body iff storyState=told; <=64KiB.
Absent text fields are omitted, not null, empty previews or placeholders. Detail
returns canonical current metadata even for a terminal/removed state, without body.
All operations authenticate the actual session, exact couple and epoch. Foreign,
missing, closed and former-member targets do not disclose text or existence details.
Authoritative session/membership checks occur after contended pair/record locks;
late receipt failure/session expiry rolls back the whole mutation.

Commands bind actor, UUID, operation, couple, epoch, target, expected version and
normalized text in a hash-only fingerprint receipt. No receipt plaintext or payload
logging. Target mutations use expected_version CAS. Retry after later removal returns
current metadata/tombstone and never reintroduces prior text. Create/tell ACKs also
contain metadata only. Reads are not read receipts and do not mutate publication state.

Complete history:100 lifetime orders per pair epoch including all terminal/tombstone
entries, waiting first then descending stable sequence. This is a synthetic technical
cap, not a pricing tier. At capacity tell/decline/own removals/read still work.
No hidden first page: all100 metadata rows remain reachable; narrative detail fetches
are separately bounded. List response <=256KiB, detail <=64KiB; request guard remains
the existing <=64KiB. No existing request, SQL, test or full-run budget is raised.

## RAM and stale-response rules

One topic composer, one story composer bound to id/version, and at most one opened
body. Manual full refresh sets checkedAt to its actual server clock, never a fabricated
entity timestamp. Mutation/detail ACKs update one canonical record, not list freshness.
Strict exact response keys reject body leakage into list/ACK, bad normalization,
time rollback and illegal identity/state/version regressions. Only a full GET list
requires all sequences1..used, no duplicate IDs/sequences and no missing known entries.
A single ACK/detail may advance known used=max(used,sequence), leave gaps caused by
concurrent partner creates, and update one record; it never confirms the full list.
Known removed/terminal text cannot be resurrected by late replies.

Each detail request is bound to target ID, known version, scope and a reader generation.
Close, open-another and scope changes invalidate the in-flight detail generation, even
if the old record stays told at the same version. Late detail cannot reopen it. Starting
another read/closing clears the prior body immediately; cancellation does not undo any
mutation. A detail at the requested known version may open only after strict validation.
If its version is newer, merge valid canonical metadata into the known list, discard
the body, close the reader and ask for explicit reopening at that new version. Older,
inconsistent or resurrected metadata fails closed. These reads do not set full-list
freshness. Refresh retains an open body only for the same identity/version still told.

Unknown mutation outcomes keep the original immutable command for explicit retry;
newer RAM input cannot alter that retry or be cleared by its ACK. Conflict requires
explicit refresh. A changed/terminal target leaves newer text visibly unsaved/stale
and blocks publication; cancelling a form does not cancel an already sent command.
Session/logout/epoch/couple changes invalidate outstanding responses and clear all
actor-scoped RAM, including reader, draft, confirmation and pending command.
Transport failure does not certify freshness; no automatic resend/realtime claim.

## Verification and limits

Tests cover both pairs, unauthenticated/former/revoked members, self-tell/wrong-author
removal, all state combinations, Unicode bounds, metadata-only list/ACK, detail ACL,
CAS races, canonical replay after removal, receipt rollback, real held-lock authority,
capacity, lost ACK/newer RAM, malformed and late snapshots/detail, and RU/EN controls.
Real PG fixtures add no minute waits. Existing Ask and existing test guarantees remain.
Early independent contract review precedes disputed implementation semantics; early
code review and focused tests precede exact clean author FULL11 and independent FULL11.
Node24.22.1; fixed API450000ms/mobile300000ms/inner5000ms, PG1110s/runner1140000ms,
four90% coverage floors and --no-cache. Physical dependencies, >=1GiB free space,
exclusive lock, sequential heavy processes, durable status/exit and full private raw.
Focused tests are not final acceptance. No production deployment, native build,
two-device E2E, E2EE, push, AI, durable drafts/offline queue or physical erasure claim.

Checkpoint on2026-11-13: API focused13/13 passed on481e34e; mobile focused24/24
passed on555b59f, with typecheck/lint and four90% coverage floors. Early code review
found a confirmation surviving batched reset/rebind; a unique reset generation now
remounts its owner, including replacement with another ready controller. Both cases
have new regression tests. Independent recheck and real PG/HTTP execution precede
acceptance; exact author and independent FULL have not run for this frozen candidate.
The two clock-fixture failures and unstable-identity UI fixture failure remain in
separate private raw evidence. Corrections changed only newly added test fixtures.
Original runner profile, environment allowlist, SQL/test budgets and existing mocks
remain byte-identical to accepted316978a. WIP restoration is checked independently
from acceptance; it does not certify feature behavior or replace accepted Library.
