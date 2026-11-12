# Synthetic chat: bounded bidirectional history

Status: local implementation; independent acceptance pending. This checkout starts
from remote `5a998162`. No earlier unpublished feature acceptance is inherited.
Opt-in loopback only, synthetic accounts/data, no production publication.

## Explicit navigation

Sign-in, Refresh history and Latest messages request the latest fifty messages.
Oldest requests the first fifty. Older and Newer replace the current window with
up to fifty messages before/after its actual boundary. Sequences are ascending
and may contain gaps. There is no 200-message browsing cutoff and no accumulated
page stack. The active display retains at most fifty messages; identity checks
compare only the old and incoming windows before replacement.

GET `/v1/couples/:pair/chat/history-window` uses membership_epoch, a fresh read_id,
direction latest/oldest/before/after, and for relative pages BOTH anchor_id and
anchor_seq. Server cursors contain `{id,seq}`. An invalid cursor keeps visible
messages/draft but disables relative paging until explicit Latest or Oldest.
Empty windows still expose Latest/Oldest escape actions. No navigation sends text.
The old `/messages` transport and tests remain available with their old contract.

Send ACK confirms the outgoing command but never navigates or refreshes history.
The user explicitly selects Latest to see newly committed messages. A concurrent
older load can finish normally without being replaced by an ACK. New composer
edits, immutable unknown-result retries and existing sending locks are unchanged.
The independent outgoing queue still has a 500-command bound; this is NOT a claim
that the whole app retains only fifty objects or supports unlimited queued sends.

## Validation and lifecycle

Strict window DTOs validate nonce, pair, row identity, sequence order, duplicate
IDs/commands, anchor bounds and exact edge cursors. No arithmetic assumes contiguous
sequence numbers. JSON is bounded to 4 MiB for fifty maximal messages. The nonce is
request correlation, not authentication or proof of freshness by itself.

Each request discovers context with a fresh credential snapshot; the cookie is
checked again before publishing a result. Account/pair/epoch changes scrub private
state. A valid nonce-bound 401/403 for the same authentication generation still
invalidates even if navigation was superseded. An old account's denial/success
cannot affect a replacement login. Incorrect-nonce errors have no auth effects.
Refresh supersedes an in-flight page. Repeated relative navigation coalesces.
Timeout/abort and unmount/logout privacy boundaries remain unchanged.

## Tests and limitations

Dedicated fixtures use strict window responses and 251 messages with sequence gaps.
Legacy authentication/send suites have a test-only latest-page adapter; it converts
only existing fixture facts, never supplies relative navigation. Obsolete tests
expecting 200 accumulated rows or automatic send refresh now explicitly assert
window replacement and deliberate Latest. Old transport/queue tests are unchanged.

Evidence logs are outside the checkout under chat-windows-rebuild-validation.
Focused tests/type/lint are not native-device or independent acceptance. Physical
RU/EN iOS/Android scrolling, keyboard, offline transitions and native builds remain
unverified. No edit/delete, realtime, delivery/read receipt or E2EE is added.
