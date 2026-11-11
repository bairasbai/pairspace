# Shared wishes: connected synthetic mobile slice

Status: implementation, not independent acceptance or native-device verification.
The default offline Kimi showcase is unchanged. The existing synthetic session
controller exposes a separate RU/EN Wishes panel in connected Chat.

## Publication and scope

- Title plus optional explanation. Both fields remain RAM-only until the user
  explicitly consents to publication for both partners and presses Publish wish.
  Changing either field revokes consent. Empty explanation is transmitted as "".
- Title reuses the shared 200-Unicode-scalar validator. Explanation permits 600
  Unicode scalars, NFC and normalized line breaks; raw input is bounded.
- This is shared content, not secret surprises or private notes. Published text
  cannot be edited or deleted. No links, purchases, assignment or notifications.
- Both active partners can explicitly fulfill/reopen displayed wishes using CAS.
  No optimistic toggles, background polling, durable drafts or offline queue.

## Retry and isolation

An unknown acknowledgement retains the immutable operation, command ID, original
title/explanation, target and expected version. A newer draft survives old replies.
Clear only clears the unsent draft; it cannot undo a submitted command. A replay
renders canonical current state, not the historical receipt. A previously observed
newer version is not replaced by an older replay response.

Version/idempotency conflicts require an explicit successful refresh before new
writes. Session, pair, epoch and cookie checks gate every request. Reset, logout,
pair leave and owned-controller unmount scrub RAM and invalidate late callbacks.
A bounded list shows up to 50 newest-created wishes, explicitly not a full archive.

## Verification

Focused tests cover controller/transport, malformed and foreign responses,
RU/EN panel, explicit consent, optional explanation, unknown ACK, canonical replay,
newer drafts, pair/epoch changes, credential changes, logout and unmount.
Use explicit test paths: the repository name also includes "wishes".
Native iOS/Android, real devices and real PostgreSQL integration are separate
acceptance gates; JavaScript tests and typecheck do not establish those results.
