# Experimental encrypted composer + one pending command journal

Base accepted18053d5c5e81f1b6771e54f0665b312948d7cf2f. Separate
pairspace-chat-journal; all accepted copies/archives retained. Synthetic data only,
no publication or production, feature disabled by default and unsupported on web.
Native device durability/security is an explicit unpassed gate.

Official Expo SQLite58.0.15 matches bundled Expo58 range; MIT package and registry
integrity verified, dependency await-lock2.2.2 MIT. Existing Expo Crypto58.0.7 supplies
AES-GCM/AAD and SecureStore58.0.2 holds keys, not message history. No homemade crypto,
SQLCipher enablement or plaintext/AsyncStorage fallback. Initial npm install failed
on unavailable default cache, then succeeded using a private workspace cache; only
two packages added and mobile manifest/lock changed. Prior dependencies untouched.

Dedicated native SQLite connection, serialized BEGIN IMMEDIATE/COMMIT/ROLLBACK;
set and verify WAL/FULL/foreign_keys/bounded busy timeout before transaction.
withExclusiveTransactionAsync uses a fresh connection that does not inherit FULL,
so it is not blindly assumed durable. SQL stores ciphertext and minimal control
metadata only. Fresh cryptographic nonce per write; AAD binds schema/origin/user/
pair/membership epoch/install generation. Keys and credentials never enter logs.

One composer and one immutable pending send/reply only; no history, edit draft,
quote, credential or token persistence. Support full8000 Unicode codepoints under
an explicit envelope byte bound, no silent truncation. Before POST, atomic snapshot
moves unchanged durable composer into pending with stable clientID/body/target;
newer draft remains separate. No POST after failed persistence.

Current online authentication/membership/origin is required before decryption or
body display. Explicit Restore and exact Retry, never autoPOST. Restored pending is
metadata-only in UI: original body is private retry material, never copied back to
composer/history/quote. Fresh canonical response alone permits message display.
Stored reply target needs fresh scoped canonical validation before a new draft send;
unavailable target preserves text and requires explicit removal, no silent plain send.
A newly typed RAM draft must not silently overwrite an unrecovered saved draft;
conflicting drafts require an explicit user choice before persistence/sending.

Fine-grained saveDraft/prepareSend/settlePending/discardPending CAS merges preserve
newer drafts. Durable lease/generation and retired tombstone are checked inside the
SQLite serialization boundary, not merely after async writes. Auth expiry suspends
and clears RAM but retains encrypted recovery material; explicit logout/account or
pair/epoch change retires the vault. Successful cleanup is not claimed on failure.
Key deletion failure leaves retired/locked state. Existing ciphertext with missing
key is locked, never treated as empty or overwritten. Orphan key with missing install
marker is not adopted; explicit confirmed reset retires data then deletes keys.

SecureStore device-only accessibility is not E2EE, uninstall erasure, anti-rollback
or Android-equivalent protection. Default native SQLite directories may be backed
up while SecureStore is excluded; backup rollback/exclusion, key invalidation,
uninstall/reinstall, locked device, power loss and actual iOS/Android acceptance
remain blockers for real data. Linux SQLite child-process SIGKILL tests prove only
the implemented process/transaction contract, not native platform guarantees.

Required tests: true process restart with real SQLite and AEAD; committed draft;
pre-send persistence and lost ACK→restart→exact retry one server row; newer draft;
no POST on storage/key/cipher error; no plaintext in DB/WAL; scope isolation and
online revocation; late writer after retirement; pending hidden/deleted privacy;
corrupt/unsupported envelopes, bounded size, nonce/AAD and explicit reset failures.
Sequential focused/API/mobile/actualPG plus frozen FULL11 and independent acceptance.

## Android backup policy and platform limits

The experimental app explicitly configures android.allowBackup=false. The private
SQLite draft/ciphertext journal is not a supported backup or device-transfer format;
SecureStore contains key/install metadata only, never draft or pending body. Existing
SecureStore plugin exclusions are not assumed to exclude SQLite automatically.
This configuration must be inspected in generated Android manifests and tested on
actual supported devices before real data. Android/OEM device-to-device transfer
behavior can differ; this flag alone is not proof that every transfer path is blocked.
Linux process restart is neither uninstall/reinstall nor backup restore/device transfer.
On iOS, THIS_DEVICE_ONLY does not imply key deletion on same-device reinstall; orphan
key/install-marker handling and actual native backup tests remain mandatory.

## Author evidence before freeze

Mobile: 2017 tests / 105 suites passed; coverage statements/branches/functions/lines
95.62/94.80/95.58/97.63%. Engine focused: 15 passed. Typecheck and lint passed
(two existing import warnings remain). Actual Linux child-process + HTTP/PostgreSQL:
13 passed in 39.487 seconds, including SIGKILL/new process, 8000-codepoint text,
pre-prepare discard, lost ACK, hidden/deleted canonical retries and storage failures.
The initial 13-case run failed during child bootstrap: Node strip-only mode rejected
a TypeScript parameter property. Only the test child launcher was corrected to use
experimental-transform-types, and initialization cleanup now preserves stderr/cause.
Intentional SIGKILL assertions remain strict. Both reports are retained externally.
These are author-focused results, not independent acceptance or native-device proof.

## Measured external verification budget

The previous complete PostgreSQL gate measured 342563 ms; the new focused process
cases measured 39487 ms. Their sum (~382050 ms) is a forecast, not a new full result.
The approved orchestration budget changes shell 360→420 seconds and runner 390→450
seconds, about 10% reserve over that forecast. Inner per-test 30 seconds, test list,
concurrency, coverage thresholds and kill grace are unchanged. Matching regression
expectations change with the budget; independent plan comparison is required.

The first frozen author candidate d8842e1 completed PostgreSQL in 413996 ms and
passed 10/11 gates; API lint failed on missing explicit Buffer imports in test
helpers. The three imports fix lint without production/assertion changes. Its
failed report/runtime are retained. Measured near-limit runtime justifies a second
approved outer-only budget: shell420→480s and runner450→510s (~16% reserve).
Matching assertions update; all inner limits/graces/thresholds remain unchanged.
A new exact frozen full is required; the earlier 10/11 is not a pass for this SHA.
