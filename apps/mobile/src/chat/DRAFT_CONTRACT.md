# Synthetic draft lifecycle contract, not shipped persistence

`draftContract.ts` is an opt-in, injected-store experiment. Neither App, auth
controller nor runtime imports it. Only synthetic tests instantiate it. No native
adapter, AsyncStorage fallback, cryptography, network calls or dependency added.
Drafts remain memory-only in the application. This does not complete restart UX.

## Security contract

Before constructing or restoring, a trusted verifier must establish the current
active user, couple, membership epoch and exact configured API origin. The
`isCurrent` callback must remain false whenever authentication/membership is stale,
refreshing, revoked or unknown. A supplied TypeScript object is not verification.
Recheck the synchronous callback at entry and after asynchronous data operations.
The harness explicitly models this boundary, not a real server login.

Disk envelope contains version, origin/user/couple/epoch and normalized draft
text only. It never accepts arbitrary extra fields, credentials, session tokens,
raw invitations, queue commands or server responses. Origin is an equality bound
namespace, not an origin authorization parser. Local session incarnation is NOT
persisted: a newly verified session of the same user and epoch can restore.
Other account/couple/epoch/origin cannot. Do not derive context from stored data.

One bounded JSON item avoids split index/body partial-write inconsistencies.
Envelope limit: 2048 UTF-8 bytes including JSON escaping and all metadata. This is
our conservative policy, NOT an Expo API size guarantee. NFC and LF normalization
reuse the existing chat domain contract; no truncation. Chat allows 8000 Unicode
codepoints, so many valid chat drafts exceed this persistence experiment's limit.
Oversized or invalid replacement clears the previous stored draft, with explicit
failure on denied deletion. Whitespace-only edit deletes. Corrupt, noncanonical,
wrong-version or wrong-scope data is rejected and purged, never reflected/logged.

Operations serialize; edits supersede queued/inflight reads and older writes.
There is one owner per injected store object. Use one store object per underlying
slot. Distinct wrapper objects accessing the SAME live slot are unsupported and
unsafe. `close()` invalidates immediately then drains and purges; call and await
it on signout, revocation, account/couple switch and unmount before replacement.
Repeated close cannot delete a replacement owner's data. Failed close retains
ownership and its cached failure; recovery requires explicit lifecycle handling,
not silently constructing a second owner. No background retries are included.

`consume()` disables the lifecycle immediately, waits for pending writes, removes
the item and verifies absence before yielding text to the send caller. Call the
existing queue/send adapter only after success and non-null text. No further edit
can persist consumed text. Unknown ACK is handled by existing in-memory queue ID,
never by restoring draft as a new command. This deliberately loses the unsent
text if the process dies after deletion but before send. No durable outbox exists.
The synthetic restart harness uses the real queue and transport with an injected
request that loses ACK, then proves the consumed bytes do not restore a new draft.
Start a new lifecycle only after command reconciliation and fresh verified context.

Store promises must be linearizable; settled operations cannot mutate later.
Readback checks catch a no-op write/delete but do NOT prove crash durability.
Errors are coarse and text-free. No secret/text logs or error causes are emitted.

## Why no real SecureStore adapter yet

Installed official `expo-secure-store` 58.0.2 is already a dependency; no new
package or license review is needed for this contract-only stage. Read its
`src/SecureStore.ts`, Android `SecureStoreModule.kt`, iOS `SecureStoreModule.swift`
and config plugin before wiring. API set/get/delete may reject; locked or
invalidated keys are not empty drafts. Android setItemImpl does not check the
boolean return of SharedPreferences commit in this installed source: resolved
write alone is not a crash-durability guarantee. A fake does not prove encryption.

Native storage uses platform Keychain/Keystore facilities, not E2EE. For a future
adapter use a dedicated origin-bound keychainService and assess
WHEN_UNLOCKED_THIS_DEVICE_ONLY, not default accessibility by accident. This is an
iOS accessibility/migration control, not Android-equivalent protection. Explicitly
review backup exclusions and any custom backup rules. Uninstall can leave iOS
Keychain entries; THIS_DEVICE_ONLY does not guarantee same-device reinstall erasure.
Biometric requirement changes UX and invalidation behavior and requires real devices.

Blocked before enabling personal data or shipping persistence:
- Durable revocation/logout tombstone and install identity design. Process death
  before/while failed close may leave an older valid-looking draft. A fresh login
  could otherwise restore it. isCurrent is not a durable deletion marker.
- Native failure/locked-device/uninstall/reinstall/backup/restore tests, actual
  supported size limits including 8k Unicode, atomicity and power-loss behavior.
- Real server revalidation before display; two accounts/pairs and revoked epoch.
- Full controller integration preserving edits, send reconciliation and lifecycle.
- Independent security review; no promise of native encryption/device acceptance.

Official API reference: https://docs.expo.dev/versions/latest/sdk/securestore/
The linked moving documentation is background; installed source informed this
assessment. No external services or personal data were used for this slice.
