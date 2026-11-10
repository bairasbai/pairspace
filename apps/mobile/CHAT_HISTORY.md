# Synthetic chat history window

Status: implemented locally, independent acceptance pending. Loopback-only synthetic
mode; no production endpoint, personal data, persistent history or new dependency.

## User path and bound

Sign-in and explicit Refresh history show the latest 50 server messages in ascending
numeric sequence order. RU/EN text explicitly says that refresh replaces the current
window with the latest 50 and older messages can be loaded again. This also applies
to refresh after a successful send. Never merge an old window with a latest page:
more than 50 new messages could otherwise hide an unrequested middle interval.
Sequences need not be contiguous; gaps in sequence numbers are not treated as loss.

Load older messages uses the server cursor with a maximum 50-row request. Loading,
error/retry, beginning-of-history and the 200-message bound have explicit RU/EN UI.
At 200 retained messages, further older loads stop with an honest limit notice.
Refresh returns to the latest 50. This is a bounded window, not an archive browser
capable of traversing arbitrarily old history. Existing outgoing queue's separate
500-command bound is unchanged. Draft and unresolved outgoing body are preserved
through history operations, and no refresh or older load retries a send.

The transport validates page scope, cursor, numeric order, message IDs and command
identity. The window union rejects any reused sequence, conflicting ID/content or
sender+client-command identity atomically; identical records deduplicate, numeric
ordering is deterministic. A rejected page does not alter the current window/cursor.

## Lifecycle and concurrency

Every older request re-reads the cookie and verifies session context with that exact
snapshot before fetching the page. Account, pair, membership epoch and session
changes clear private state; an old cursor is never applied to a replacement scope.
No cached context permits a retry after failed verification. Missing credentials,
auth denial and malformed context fail closed. Transient failures keep the window
and provide explicit retry. Same-generation late 401/403 still invalidate, while
old-generation responses cannot hydrate or clear a replacement lifecycle.

Repeated older taps coalesce while busy. Refresh supersedes an older request and
its completion cannot append to the reset window. Send may supersede discovery;
a successful send refreshes and invalidates older-page hydration. Requests obey
the controller's existing timeout/abort boundary. Sign-out and disposal erase
history/draft/outgoing and invalidate pending responses. This is no server revocation
or promise that an already issued external request was cancelled.

## Verification

- `__tests__/auth-chat-history.test.ts`: order, cursor, cap, end, duplicate/conflict
  handling, retry, scope/cookie changes, send/refresh races, late denial and cleanup.
- `__tests__/connected-chat-history.test.tsx`: connected RU/EN renderer loading,
  double taps, retry, end, 200-message notice and refresh reset.
- `services/api/tests/postgres/mobile-chat-history.integration.mjs`: actual controller,
  official synthetic auth, loopback HTTP and real disposable PostgreSQL; >50 rows,
  noncontiguous sequences, pair isolation, authorization and >50-new-message reset.
- Results: `evidence/chat-history/`. Full mobile collection includes unimported
  own production sources and shared domain modules, with the unchanged 90% gate.

Not verified: physical iOS/Android, native builds, scroll position/keyboard ergonomics,
SecureStore execution or network transitions on device. Expo exports only bundle JS.
No deletion, realtime, delivery/read receipts, production deployment or E2EE added.
The broader CHAT P0 and native acceptance gates remain open.
