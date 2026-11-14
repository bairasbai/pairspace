# Bounded chat reconciliation
Base ab81b6019ccf2ad7621b81f8064ace844477b97f, standalone author clone.
Read-only scoped snapshot of up to50 displayed canonical messages plus one original
detail and one selected reply target (at most52 distinct IDs); latest visible ID/seq gives a new-message indicator without moving history.
Explicit Reconcile and inactive/background→active only, no polling, background job,
automatic POST, read receipt or notifications. Journal remains experimental/defaultoff.

One authorized pair-lock transaction captures canonical projection and actor-private
visibility revision. Missing/foreign/hidden IDs uniformly unavailable. Exact input and
output cardinality, known IDs and immutable identity/seq checked, monotonic version and
terminal ledgers preserved. Unavailable is not invented deletion. All current-session
auth denials revoke local access even if read obsolete; prior session replies ignored.
Draft, edit draft, immutable pending retry and viewed history position survive updates.
No automatic resurrection from cached quote or journal pending. App foreground bursts
coalesce; no subscriptions leaking after logout/unmount. Current-visible snapshots only,
not complete realtime synchronization, delivery/read receipts or production readiness.

Acceptance:267+ records, oldwindow edits/deletes and offwindow target; uniform private
visibility and different pairs; lockwait revocation and snapshot/hide ordering; exact
nonce/session/SHA races, late ACK/newdraft, unavailable clears old derived body; no writes
or outbox; RU/EN UI and lifecycle listener tests. All existing tests retained, >=90 all
coverage metrics, <=600 lines, frozen author FULL11 then independent exact gate.

The two optional source roles may coincide with window IDs or each other; the server
deduplicates lookup without changing exact role bindings. Both distinct offwindow
sources are refreshed. No role bypasses membership or private visibility. Missing,
foreign and hidden targets use the identical null result; there is no existence flag.

## Wire contract
GET `/v1/couples/:coupleId/chat/reconcile` requires `membership_epoch`, fresh
`read_id`, `message_ids` (comma-separated0..50 UUIDs, unique after normalization),
optional `detail_id` and `reply_target_id`. Unknown/repeated keys are rejected.
Synthetic API feature flag defaults false, independent of journal storage setting.
Response value contains readId, messages and unavailableIds in requested role order,
detail and replyTarget as null or `{id,message:null|canonical}`, plus latestVisible
as null or `{id,seq}`. Missing/foreign/hidden are the same unavailable projection.
Visible terminal messages remain canonical tombstones. No counts or readiness flags.
The client validates exact partition, role/identity/sequence binding and overlapping
role equality, then applies existing edited-version and terminal-deletion barriers.
Private visibility revision is captured atomically with this response, not later.

The indicator means “later messages are available”, not a count or proof that a message
arrived after the last check: a reader on an old window may already know later rows.
A selected reply source becoming unavailable must not turn a draft into a plain send.
Its text preview is removed, but attachment intent remains blocked until an explicit
user action resolves or removes that source. This rule applies with journal disabled.

## Author focused evidence before freeze
API5/5 passed with both new modules included:100/98.87/100/100 coverage. Type/lint
passed. Mobile sequential focused35/35 passed; four new own modules98.81/96.85/100/100.
Actual PostgreSQL/HTTP combined12/12 passed in14.240s: proven lock waits and expiry,
body/revision atomicity,267-row navigation, both distinct offwindow sources, private
visibility, no writes, pending ACK/drafts and old/current session denials.
Initial focused coverage invocation selected no files (0/0), later corrected; mobile
fixture/type and low-targeted-coverage failures retained. One initial core PG run
crossed a mobile test launch; it is not used as final sequential evidence. The combined
12-case rerun occurred exclusively. Frozen full and independent acceptance still required.

Whole mobile2041/2041 passed across109 suites; total coverage95.66/94.90/95.52/97.67.
The extracted pair-feature composition is covered100% in all metrics. AppState tests
exercise actual listener registration, transition handling and cleanup, not a device.
If a same-revision unavailable edge invalidates a retained history anchor, subsequent
navigation may require an explicit window reload; reconciliation does not silently jump.
