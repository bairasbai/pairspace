# Shared doings: source-grounded bounded candidate

Status: implemented synthetic candidate; early semantic/API reviews passed.
Mobile replay finding reproduced and fixed; focused API12/mobile29 passed.
RealPG execution and both exact FULL pending at this dated checkpoint. Not accepted.
Base: accepted afd0770404158544c3363b09f17d31032829095c, Library v19.

## Source and selection

Read-only Tan Ata4822e213e991f6e8c0177751e0fd6626b1f237bc: doings/page,
DoingStart/DoingStep in TalkParts, allDoings/startDoing/markStep in lib/talk,
beginDoing/step actions and catalogue. All seven comparison blobs were hashed.
The source records book/series/course/other, an immutable title and positive total
parts, each person's monotone position, and automatic completion when both finish.
It offers no manual finish button. It assumes two fixed participants and treats
missing progress as zero. Its notify code and source text/data are not copied.

Existing SharedTasks has a single shared complete/reopen state and latest50 list;
it has no separate personal positions. This slice represents progressing separately
through the same book/course/series, rather than another task-completion button.
Bets needs a dated judgment/stake policy; Sealed needs calendar release semantics
and overlaps scheduled letters. Both were read and remain separate future work.

Amio adaptations, not asserted source rules: explicit joining/refusal, own-progress
withdrawal, author removal, bounded full100 history/title200/parts1000 and CAS/receipts.
No deadline, reminder, penalty, automatic participation, payment, health import,
scoreboard, live presence, realtime, background task, edit or progress decrement.

## Participation, visibility and removal

Either active member explicitly proposes a doing. Its title/kind/parts and the
creator's position are shared with the other member immediately; create confirmation
explains this. Creating joins only the creator, at0. The recipient is invited, with
no progress value: invitation is not consent or a claim that they are at zero.
Recipient may leave it invited indefinitely, explicitly join at0, or decline.
Joining needs explicit confirmation that their progress will be visible to both,
that withdrawal later clears their position and stops the doing for both, and that
the author may remove the proposal including BOTH positions. Create confirmation
also explains those removal/withdrawal consequences. Decline/withdraw confirmation
states which own position is cleared and that current complete becomes false;
author removal confirmation explicitly says title/total and BOTH positions disappear.
Only that actor may advance their own position, to a strictly larger integer within
the declared total. Recipient cannot advance while invited; creator may advance
while waiting. Both positions are visible after joining. No actor sets the other's
position. A completed doing offers no further advance; complete is derived exactly
from joined and both positions equalling parts, never a manual finish declaration.

Recipient may explicitly decline while invited OR withdraw after joining, including
after completion. This is terminal for this doing, clears their own position, and
stops both from advancing. The UI distinguishes invitation decline from withdrawing
an existing contribution. The derived current complete flag becomes false; this is
not a historical ledger and no completedAt/proof-of-reading timestamp is invented.
Creator's last position/title remain visible to both until author removal. Refusal
is visible, asks no reason, imposes no obligation and never disables other features.
Recipient cannot delete the author's words. Creator may remove their own proposal
at any state, including declined/completed. Removal clears title/kind/parts and BOTH
positions; only scoped tombstone metadata remains. It withdraws an invitation if
still invited, otherwise preserves joined/declined decision history. It cannot undo
prior copies/backups; no physical-erasure claim. No edit/revival/rejoin/restore.

Metadata immutable: id,coupleId,authorId,recipientId,membershipEpoch,sequence,createdAt.
Mutable: version,contentState active|removed,decisionState invited|joined|declined|withdrawn.
Active records contain exactly title,kind,parts,authorAt; recipientAt only when joined.
Removed records contain none of those fields. withdrawn is removed-only; invited is
active-only. Derived complete is a client/domain function, not a redundant wire field.
AuthorAt is0..parts when active; recipientAt exists iff active AND joined. Title/kind/parts never change
while active. Legal transitions are invite->join, invite/join->decline, own advance,
and author removal. Every successful fresh mutation advances version exactly once;
no fresh no-op, backwards step or clamping of out-of-range input. SQL also rejects
identity/text edits, arbitrary revival/transition/no-op and physical row/receipt delete.

## API, bounds and authority

Independent default-off loopback-only opt-in. No existing API/guard/mock change.
GET/POST /v1/couples/:couple/shared-doings: full scoped list / propose.
POST :id/join, :id/decline, :id/advance; DELETE :id for author removal.
GET only membership_epoch. Create exact payload membership_epoch,command_id,
title,kind,parts,confirm:true. Targets exact membership_epoch,command_id,
expected_version,confirm:true; advance additionally part. The actor is server-derived.
Idempotency-Key must match command_id. No mutating GET or device-supplied timestamp.
All envelopes exactly {ok:true,value} or {ok:false,error}; omitted fields are absent,
not null/empty placeholders. List value doings[],checkedAt,capacity:100,used;
max256KiB. ACK value doing,commandId,replay; max16KiB. Existing request64KiB stays.
Title NFC/CRLF normalization/trim, no controls or lone surrogates,1..200 codepoints;
raw RAM title<=800 UTF16 units. Kind enum book|series|course|other; parts integer1..1000.
Lifetime100 per exact pair epoch includes tombstones/declines, contiguous sequence.
At capacity join/advance/decline/remove still work. Versions integer1..2004; no-op
advances rejected. Ordering buckets: actionable active (invited or joined&&!complete),
then active completed/declined, then removed; each descending sequence. Active declined
is not actionable even though complete=false. No deadline grouping.

For first-snapshot reachability, I(x)=1 if x>0 else0, a=authorAt, r=recipientAt,
p=parts. State-specific version ranges, inclusive:
- active/invited: [1+I(a),1+a].
- active/joined: [2+I(a)+I(r),2+a+r].
- active/declined: [2+I(a),3+a+p], covering direct decline or joined withdrawal.
- removed/withdrawn: [2,1002]; removed/joined: [3,2003]; removed/declined: [3,2004].
For known old active state, let da=newAuthorAt-oldAuthorAt>=0, dr similarly when
both joined; A=p-oldAuthorAt, R=p-oldRecipientAt. Reachable version deltas:
- invited->invited: [I(da),da]; joined->joined: [I(da)+I(dr),da+dr].
- invited->joined: [1+I(da)+I(newRecipientAt),1+da+newRecipientAt].
- invited->declined: [1+I(da),2+da+p]; joined->declined: [1+I(da),1+da+R].
- invited->removed/withdrawn: [1,1+A]; invited->removed/joined: [2,2+A+p].
- invited->removed/declined: [2,3+A+p]; joined->removed/joined: [1,1+A+R].
- joined->removed/declined: [2,2+A+R]; declined->removed/declined: exactly1.
Unchanged terminal state allows only delta0 and exactly identical data. Equal-version
records must match every field. No other state transitions; removed never revives.
Numeric nonregression applies only while the relevant position remains present;
explicit withdrawal clears recipientAt and removal clears both. These are the only
clearing exceptions. Old complete cannot advance: its remaining A=R=0.

Every operation authenticates actual session, active exact two-member pair and epoch.
Foreign/missing/former/closed targets fail closed without record/existence disclosure.
Pair and target locks serialize create/cap, transitions and current canonical replay.
Authority is rechecked after pair/row/receipt waits and after returning private fields.
Late expiry after a fresh update/receipt wait throws a sentinel so state/progress/
version/receipt roll back atomically. Trusted finite server clock only for createdAt
and checkedAt; neither session identity nor client IDs choose another user's slot.
Receipt keyed actor+UUID stores fingerprint/target/scope, never title or progress.
Fingerprint binds operation,target,epoch,expected version,confirm and normalized
create/advance data. Same command with altered payload/operation conflicts. A retry
projects CURRENT canonical state, including withdrawal/removal, never cached content.
For every replay, reconstruct the successful original operation (version+1, exact
own part/join0/decline clear/remove, or proposed v1 with original total) and require
canonical reachability FROM THAT RESULT as well as from the latest known record.
Reachability from the pre-command snapshot alone does not acknowledge that command.
Version CAS applies to every target mutation: concurrent updates get one winner,
the loser must explicitly refresh and choose again; no automatic merge/resend.

## Mobile RAM, strict response and lifecycle fences

One RAM composer (title,kind,parts) and immutable pending command. A newer draft
revision survives an old create ACK; cancel only clears current input. Unknown ACK
offers retry of the exact command, including target/part/version/epoch, never a new
ID. Refresh is allowed with pending command; it does not discard or auto-resend it.
Canonical replay after author removal cannot restore title or positions. Only a
full explicit GET certifies complete contiguous history; ACK may fill gaps and
used=max(sequence), but cannot mark a partial collection checked/fresh.
Strict key/UUID/scope/role/state/version/time/text/bounds/duplicate/sequence/order
validation; latest known canonical identity and nonregression checked before merge.
Same-version data must match; tombstones cannot revive. Older full GET cannot omit
known records, replace immutable title/total or regress a personal position/state.
CheckedAt never regresses or precedes a record's creation. No body in logs/URL/push.

Confirmation/progress input is keyed by a globally unique controller generation and
record identity/version. Reset/rebind/controller replacement clears old confirmation
and row input even when actor/id/version match. No stale confirmation may operate on
a replacement scope. Scope/logout/epoch/couple change and dispose clear all private
RAM/pending and invalidate in-flight responses. Cookie/session binding rechecked
before and after request/JSON; late old actor ACK cannot cross scope. Panel unmount
clears local row input/confirmation; controller's RAM composer/pending may survive
mode navigation within the same live session. No persistence or offline queue.
Explicit load and retry only. RU/EN copy explains sharing/refusal/withdrawal; iOS/
Android renderer configurations are not native or two-device evidence.

## Verification boundaries

Test A/B pairs, both roles, former/unauthenticated/revoked/expired, role tampering,
SQL legality/cap100, independent positions/derived completion, withdrawal after
completion, removal and canonical replay, global CAS races, real held row/receipt/
provider-session waits, late-authority rollback, lost HTTP ACK/new draft, scope clear,
StrictMode/reset/rebind/controller replacement and malformed bounded wire responses.
Before FULL: clean exact SHA/physical dependencies, Node24.22.1,>=1GiB free, shared
exclusive heavy lock, durable status/actual exits and explicit abort. Same existing
FULL: API450000ms, mobile300000ms/inner5s, PG1110s/runner1140000ms, all four coverage
floors90%, --no-cache. Heavy sequential; no prewarm/split or weaker mocks/assertions.
Author exact11 then independent separate-checkout exact11 required. All full raw22
each retained privately0600/16MiB per stream, complete bytes/hash audit and privacy
review before portable Library WIP. Preserve all failures. Accepted19 and earlier
WIPs unchanged. No GitHub/main/production, native build/two-device E2E or E2EE claim.
