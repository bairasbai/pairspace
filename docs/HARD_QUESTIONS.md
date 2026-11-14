# Hard questions: source-grounded bounded candidate

Status: implemented synthetic candidate; early semantic/API/mobile reviews passed,
real PG execution and both exact FULLs pending. Not accepted.
Base: accepted67c6607dc42d95655bd4caed53d2156a2f9d4192, Library v18.

## Source and distinction

Read-only Tan Ata4822e213e991f6e8c0177751e0fd6626b1f237bc:
app/talk/hard/page.tsx, HardAsk/HardOpen in components/TalkParts.tsx,
hardQuestions/askHard/openHard in lib/talk.ts, app/talk/actions.ts and catalogue.
The author can see their own question. A recipient receives no sealed text until
explicit opening; authors cannot open their own question. openHard updates only
opened_at IS NULL, then returns text. hardQuestions subsequently returns opened
text on later visits. Thus the irreversible action occurs once; text does not burn
after a single response/display. The catalogue's stronger wording is not a data-loss
rule. Network loss must not consume the only opportunity to receive an opened text.

Distinct from Ask: an authored question is hidden from its recipient until consent;
there is no question/answer exchange mutation. Distinct from Stories: the body is
permission-gated, not merely behind an explicit reader. Distinct from Blind/Stems:
no second answer is required to unlock another author's text. No deadline, reminder,
answer obligation, pressure, fixed source identities or provider notification.

Bounded adaptations: metadata-only complete history and explicit reader, Unicode
limit2000, lifetime100 cap, recipient decline without disclosure and author's removal.
These limits/refusal/removal are Amio adaptations rather than claimed source rules.
No original source code, personal text, private files or notification code is copied.

## Voluntariness, visibility and authorship

Either member of an active exact pair epoch may explicitly seal a question for the
other member, derived by the server. Only that recipient may open or decline it.
The recipient may leave it sealed indefinitely. Opening requires a separate explicit
confirmation explaining that the state/timestamp becomes visible to both, the text
will remain readable until author removal, and opening never requires an answer.
Do not describe this state change as proof of actual reading or a duty to respond.

Decline also needs explicit confirmation: no text is revealed, no reason is requested,
the choice is terminal and visible to both. A declined envelope cannot later open.
There is no decline by timeout or inference from silence. No notification or badge
counting work is added in this slice. Leaving the screen and closing the reader are
local actions; they do not decline, remove or re-seal a question.

Only the author can remove their own question text for both members, with explicit
confirmation. Sealed removal withdraws before opening. Removal after opened/declined
preserves the recipient's original state and openedAt when applicable. Recipient
decline never erases the author's own readable copy. Recipient cannot remove another
author's words; they may close their RAM reader. Removal cannot erase prior copies or
backups. No edit/replacement/restore, second opening transition or new answer field.

Metadata identity: id,coupleId,authorId,recipientId,membershipEpoch,sequence,createdAt.
It also contains version,contentState,decisionState and openedAt iff opened; never text.
Legal states and versions:
- active/sealed v1, no openedAt.
- active/opened v2, openedAt retained.
- active/declined v2, no openedAt.
- removed/withdrawn v2, no openedAt.
- removed/opened v3, original openedAt retained.
- removed/declined v3, no openedAt.
Content is stored iff active. Removed text is NULL in storage and absent on the wire.
Text is immutable. openedAt=max(trusted server time,createdAt), set by the one fresh
recipient opening, not fabricated by a read or device clock. Body access is allowed
iff content active and (actor author OR (actor recipient AND decision opened)). Recipient sealed/declined
text is neither selected nor returned. All body reads follow actual scope/session
authorization after contended locks and are followed by another session check.

## API and bounded wire shapes

Independent default-off loopback-only opt-in; existing APIs remain unchanged.
GET/POST /v1/couples/:couple/hard-questions: metadata list / seal a question.
POST :id/open and POST :id/decline: recipient transitions.
DELETE :id: author's text removal. GET :id/text: explicit role-gated text read.
GET accepts only membership_epoch. Create payload is exactly membership_epoch,
command_id,text. Target commands have exactly membership_epoch,command_id,
expected_version,confirm:true. Actors/timestamps/state are never request fields.
Every mutation binds Idempotency-Key to command_id. No mutating GET.

Every envelope is exactly {ok:true,value} or {ok:false,error}; absence is omitted,
never null/empty-preview placeholders. Metadata is the exact shape above.
- List value: questions(metadata[]),checkedAt,capacity:100,used. Max256KiB.
- Create/decline/remove ACK: question(metadata),commandId,replay. Max16KiB.
- Open ACK: question(metadata),commandId,replay,checkedAt, and text iff currently
  active/opened. Max32KiB. Only authorized recipient opening/replay can use it.
- Detail: question(metadata),checkedAt, and text iff body access allowed. Max32KiB.
Open returns text immediately when still active/opened, matching the original flow;
it is not dependent on another tap or a one-time unrepeatable response. Canonical
retry after later author removal returns removed metadata without old text. Other
ACKs and lists never carry body. No text in URLs, fingerprints logs, counters or push.
An OpenACK must keep decisionState=opened, including removed/opened on replay;
declined/withdrawn/sealed cannot acknowledge a successful opening. Before any text
display, validate its canonical metadata against the LATEST known record with the
same identity and a legal nonregressing transition. A stale ACK cannot undo a known
tombstone, reintroduce removed text or override a newer local metadata version.

All operations authenticate actual session and exact active two-member pair epoch.
Foreign/missing/closed/former-member targets do not disclose text/existence details.
Authoritative checks occur after pair/record locks and receipt waits. Expiry/revocation
after a fresh state update throws to roll back state/timestamp/receipt atomically.
Actor+UUID receipt stores only a fingerprint and target, never plaintext. It binds
operation,couple,epoch,target,expected version,confirmation and normalized text.
Matching retries project current canonical state; different payload/operation conflicts.
Target operations use version CAS. Open/decline/remove races have one winner; loser
refreshes explicitly, never silently changing choice. No fresh successful no-op.

NFC, CRLF to LF, trim; LF is the only permitted control, reject lone surrogates.
Published text1..2000 Unicode codepoints; raw RAM input<=8000 UTF16 units. History
is100 lifetime questions per epoch including terminal/tombstones, sealed first then
descending stable sequence. Technical synthetic cap, not tariff. At capacity existing
open/decline/remove/read still work. Existing request64KiB guard stays unchanged.

## RAM, reader generations and immutable retry

One author composer and at most one reader body, all RAM-only. Only an explicit
complete GET certifies history/checkedAt: all sequences1..used, no missing known
records, duplicate IDs/sequences, illegal identity/state/version transitions or time
regression. A single ACK/detail may fill a sequence gap and advances used=max;
it never certifies completeness or marks other rows fresh.

Unknown mutation outcome retains the original immutable command; edits/cancel of
newer RAM input never rewrite or cancel it. Its ACK clears input only at matching
revision. Conflict requires refresh. There is no automatic resend or durable queue.
Every controller reset gets a unique generation across instances; the confirmation
owner is keyed by it so batched reset/rebind and ready-controller replacement clear
old confirmations even at same actor/record/version. Confirmation stores metadata only.

Each GET detail binds id/version/scope/reader generation. Close/openB abort and
invalidate old detail, even at unchanged version. Newer canonical detail merges
metadata, discards text and requires explicit reopen; older/inconsistent text fails
closed. Refresh keeps a reader only at same identity/version still authorized.

Opening is a mutation: closing during its flight invalidates display intent but
cannot undo consent already committed. Its late ACK may merge canonical metadata and
resolve pending, but cannot reopen a closed reader. The immutable pending command
captures the reader generation from the original opening; retry displays text only
if that generation remains desired. After close, retry can confirm state without
showing text; a later explicit read can show an opened question. ReadB is blocked
while an opening outcome is unresolved. The UI explains local close vs server choice.
Leaving this mode, navigation away and actual panel unmount are local Close: clear
reader text and invalidate in-flight display intent. They do not cancel/undo a sent
mutation or discard its immutable pending command while the session remains alive.
Returning requires an explicit read/retry; an old OpenACK cannot reopen the reader.
Controller replacement closes the old instance only; scope reset/dispose additionally
clears all actor-private RAM/pending as specified below. Lifecycle code must preserve
these fences under React StrictMode effect replay without touching a replacement.
Session/logout/epoch/couple changes clear draft, body, pending command and confirmations,
invalidate responses and abort detail. No stale private content crosses account/scope.

## Verification and explicit exclusions

Tests: both pairs/former/unauthenticated/revoked, cannot self-open or remove other's
question, recipient unopened/declined GET never issues protected body query, exact
wire shapes/bounds/Unicode, all states/forbidden transitions, canonical open retry
after removal, capacity, real held locks/session expiry/rollback, CAS races, lost ACK
and newer RAM, close during open/GET, openB, scope changes, confirmations, RU/EN/iOS/
Android component configurations and offline/interrupted flows. No existing mocks or
test guarantees changed. Real PG fixtures add no minute waits.

Early independent semantic review precedes disputed implementation. Focused and early
code review precede clean frozen author FULL11 then separate independent exact FULL11.
Node24.22.1, API450000ms, mobile300000ms/inner5000ms, PG wrapper1110s/runner1140000ms,
all four coverage floors90%, --no-cache; physical dependencies,>=1GiB,shared exclusive
heavy lock,sequential tests,explicit abort,durable exit/status and full private raw.
Source/evidence WIP has its own Library identity; accepted v18/stories WIP stay intact.
No native build/two-device E2E, E2EE, production, AI, push, physical-erasure, durable
drafts/offline or clinical/crisis-support claim. This is a voluntary conversation tool.

Checkpoint2026-11-13: standalone APIcore7d180cf focused11/11 passed; wiringe8179e6
API12/12 and mobile25/25 passed, with typecheck/lint and all four coverage floors.
Static semantic/API/mobile reviews have no open blocking findings. Added subsequent
tests combine StrictMode/replacement/lateACK and refresh/unknown-open/Close/retry.
Dedicated realPG tests cover CAS/cap/privacy, receipt-FK expiry rollback, private-read
row-wait expiry and provider-session wait revocation; the latter serializes at the
actual provider SHARE lock, not an impossible concurrent delete after that lock.
ActualHTTP/official-auth/mobile test covers lost ACK, explicit reread, choices,
author removal and closed-epoch clearing. RealPG additions await runtime verification.
Follow-up c07a6d7 focused mobile27/27 and API12/12 passed with typecheck/lint and
unchanged coverage floors; the two extra lifecycle/retry combinations are included.
This dated pre-FULL checkpoint stays frozen; later full results are separate evidence.
