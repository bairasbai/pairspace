# Continue the phrase: bounded shared invitation and sealed continuation

Approved contract; implementation and independent final acceptance pending.
Base accepted654729172e6119811fd897a4b823436eb8f8c5a9.

## Why this next
PRODUCT_BACKLOG names Continue the phrase as a standalone P1 mode.
Read Tan Ata @4822e213e991f6e8c0177751e0fd6626b1f237bc:
app/talk/stems/page.tsx; components/TalkParts.tsx StemStart/StemFinish;
lib/talk.ts allStems/startStem/closeStem.
Source author supplies a shared beginning and their own hidden continuation together;
recipient supplies their own continuation once, then both become visible. Author may
read own continuation before completion; recipient's SQL projection omits it before
completion. Pending-first history. No original private texts/configuration copied.
Distinct from existing fixed-catalog symmetric blind rounds: a user authors the
beginning and commits their own continuation at creation. Does not modify old blind
rounds, their retained answers, or their disclosure policy. Not another Ask skin.

## Publication, rights and state
Exact active couple epoch, server derives recipient. Either current member starts.
Explicit confirmed create shares beginning and the fact of an invitation, but only
author can read their own committed continuation while waiting. Recipient is told
what submitting will publish and reveal; can skip without explanation or deadline.
No edit of committed texts, no score/similarity evaluation, no reminder/pressure.
RAM input is not a durable draft. No provider/notification/native/AI scope.

Fields: id,coupleId,authorId,recipientId,membershipEpoch,sequence,version,createdAt.
phase: waiting | completed | skipped | withdrawn.
authorTextState: active | removed; author-owned beginning+continuation are one bundle.
recipientTextState: absent | active | removed.
completedAt present only for completed, logical max(serverNow,createdAt), not receipt.

Allowed states:
- waiting: author bundle active, recipient absent; beginning shared, author continuation
  visible only to author. Version1.
- completed: recipient submitted once; both active continuations are shared. Version2.
  Later own removals preserve completed state and timestamp, never relock or allow
  another response. Author bundle and recipient text can each be removed separately.
- skipped: voluntary recipient terminal choice, recipient absent. Author continuation
  stays author-only forever, never revealed because of skip. Version2.
- withdrawn: author removed own bundle while waiting; recipient absent. No text remains.
  Distinct from partner's voluntary skip. Version2.
Author bundle may be removed after skipped without changing skip; after completed
without deleting recipient-owned continuation. Remaining partner continuation retains
attribution even when the beginning is gone. Recipient may remove their completed
continuation only; remaining author bundle remains shared because reveal already happened.
No restoration, replacement or re-answer; matching command retries return current
canonical projection. Fresh invalid terminal operations are version_conflict.

## Commands and privacy projection
create(beginning,ownContinuation), complete(recipientContinuation), skip,
removeAuthorBundle, removeRecipientContinuation. New valid transition increments
version once; exact matching replay never increments or republishes old text.
All mutations CAS except create, immutable command ID, atomic metadata receipt.
Exact authorization including replay and final auth after waits/receipt insert; rollback
sentinel outside transaction. Serial locks prevent complete-vs-skip/withdraw races.
The race winner determines canonical state; loser cannot commit/reveal by stale version.

Before completion recipient read/skip/conflict/replay responses contain NO author
continuation, including empty body, size/hash/preview or edited flag. Authorized query
only selects hidden continuation for author or after completed state under locks.
No SELECT * or read-hidden-then-strip. Returned fingerprints never exposed/logged.
A recipient complete request with invalid/missing text or failed auth does not reveal.
A structurally valid stale-version command against an already legitimately completed
round may return current authorized completed projection, just like GET. It does not
perform first disclosure or accept another continuation. A losing command against
skipped/withdrawn state never reveals the author continuation.
Removing own recipient text after completion does not hide author's already-revealed
text, nor reopen submission. Skip does not trigger mutual reveal. Server-side plaintext
with access control, not E2EE or cryptographic erasure; fingerprints/backups retained.

## Bounds, history and client consistency
Beginning1–500 Unicode code points; each continuation1–2000; normalized like Ask
(NFC, trim, CRLF->LF, paragraphs retained; invalid controls/lone surrogates rejected).
100 lifetime rounds per couple epoch including removed/terminal rows, explicitly
synthetic technical cap rather than tariff or production claim. At cap completing,
skipping and own removal remain possible. Complete bounded history, waiting first,
then sequence descending. A2MiB response ceiling must be mathematically checked
against maximum UTF8/JSON bodies+metadata and exercised with worst-case allowed input;
raise only this bounded transport ceiling if needed, not reduce accepted text silently.
Only full GET marks complete snapshot checked; mutation ACK updates one round.
Exact state/version graph validation rejects resurrection/reverse transitions and
hidden-body leakage. Role-specific views must remain compatible as the actor changes.
Newer RAM input survives unknown ACK and becomes explicitly unsaved/stale when target
terminates; actions disabled until explicit cancel/reload. Actor/epoch/session fencing.

## Confirmation copy
Create: beginning shared now, own continuation sealed from partner until they submit;
both continuations then shared, cannot edit; may remove own bundle later.
Complete: publishes your continuation and reveals other's, once, optional.
Skip: optional terminal choice, does not reveal other's continuation.
Author remove: removes your beginning AND your continuation; if waiting withdraws;
if completed, partner continuation stays visible. Already-read copies not erased.
Recipient remove: removes only your continuation; author's remaining text still visible,
no replacement/re-answer. Confirmation stores IDs/version only, not removed body copy.

## Verification boundaries
Separate branch from accepted base after agreement; current scale deps only once allowed.
Independent early contract/code review before freeze. Pure normalization/state tests,
HTTP strict fields/current-epoch/idempotency, SQL constraints/projection trace proving
no hidden field selected for recipient before completion, bounded realPG complete/skip/
withdraw/removal races and actual post-receipt FK wait auth rollback. No new minute waits.
Mobile RU/EN, visibility, confirmations, maxUTF8 response, retry/current tombstone,
newerRAM, staleGET/ACK and role/session isolation. AuthorFULL11 then independentFULL11
exactclean SHA and byte-restored archive. Existing API450/PG1110+1140 budgets unchanged.
No GitHub/main/production writes or native/two-device readiness claims.

## Focused candidate checkpoint
Mobile bounded69tests PASS with original5s inner test limit; two earlier existing
synthetic-app timeout runs retained, cause unproven. No exclusions or threshold
changes. Owned mobile coverage96.28/96.72/100/96.15; type/standard lint PASS.
Initial backend37tests PASS and realPG comprehensive test PASS4.87s; deterministic
terminal-first SQL projection regressions added before final focused rerun.
Worst permitted100 completed UTF8 histories pass the actual2MiB mobile reader.
These focused results are not final acceptance, native or production proof.
Frozen author and independent FULL11 remain mandatory.

Final focused backend37/37PASS, coverage96.35/96.38/100/98.15, type/lintPASS.
Final realPG PASS6.49s includes deterministic skip-first/withdraw-first privacy
traces and completed-first stale-command authorized projection; no assertion or
timeout relaxation. Final actual independent review precedes source freeze.
