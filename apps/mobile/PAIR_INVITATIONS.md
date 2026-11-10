# Explicit synthetic invitation client

Status: implemented; independent acceptance pending. This is an explicitly injected,
loopback-only development flow, not production onboarding. The default application
continues to use no auth runtime or network. API flags remain independently enabled
by the synthetic server host; the mobile client cannot enable server routes.

See [API issuance](../../services/api/PAIR_INVITATIONS.md),
[API acceptance](../../services/api/PAIR_ACCEPTANCE.md),
[verified context](SESSION_CONTEXT.md), and [official auth](AUTH_INTEGRATION.md).

## Runtime and public interface

`createSessionController(config, officialClient, request, commandId).invitations`
exposes `getSnapshot`, `subscribe`, `readMetadata`, `issue`, `revoke`, `setToken`,
`preview`, `setConsent`, `accept`, and `cancel`. Actions take no identity, pair,
invitation, epoch or session selectors from UI code. Only `setToken(string)` and
`setConsent(boolean)` accept user input. `AuthView` and the existing chat contract
are unchanged. Invitation state belongs to a separate subcontroller.

`InviteView` contains:

- `mode`: unavailable, owner, or recipient, derived only from verified context.
- `busy`: null, read, issue, revoke, preview, or accept. Operations do not queue.
- `invitation`: validated metadata or null; `issuedToken`: first-response token or null.
- `tokenInput`, `preview`, and `consent`: ephemeral recipient input and explicit decision.
- `recovery`: none, issue_uncertain, revoke_required, revoke_uncertain, or accept_uncertain.
- `error`: a bounded code, never request/response content or an exception message.

The official Better Auth Expo adapter remains the credential owner. Every action
captures its host generation and verified identity/context, reads the official
cookie, and obtains authoritative context using that exact cookie. It compares
session/domain user and, for an owner, the waiting pair and membership epoch.
It rechecks the current SDK cookie before transmission and after the response;
a different cookie is never substituted into an operation already in progress.

Requests use the frozen, strictly validated HTTP loopback origin, Cookie and Origin
headers, `credentials: omit`, `redirect: error`, and `cache: no-store`. No bearer
fallback, query token, caller-selected identity or automatic route activation exists.
Parent requests carry a ten-second abort deadline; response JSON has a ten-second
read deadline and a 4096-byte limit. The runtime adapter must honor Request signals.
The parent forwards both lifecycle and operation cancellation signals.

## Owner: issue, inspect and revoke

Only `waiting_partner` context exposes owner controls. Reading metadata is explicit
GET `/v1/spaces/waiting/invite`; it never obtains or recovers a raw token. Issuance
is a separate POST with a fresh host-generated UUID command. Only a valid first
201 response may display its token. A 200 replay has token null.

Uncertain issuance does not automatically retry, rotate or create another command.
The user explicitly reads current metadata, revokes that exact ID, then explicitly
issues again. If the authoritative read returns no current invitation, another
explicit issuance is allowed. This is not proof an older request never committed;
server transactions and uniqueness still arbitrate a delayed conflicting issuance.

A read showing the same pending invitation can retain its already displayed token.
A changed ID/status or absent current row clears it. Neither metadata reads nor
replays can resurrect a token cleared by cancellation or unmounting.

Revoke is conditional DELETE with the captured invite ID. A lost acknowledgement
retains that exact target independently of displayed metadata. Reading a newer
invitation never retargets a retry, and a successful retry of the old revoke never
clears the newer invitation. No tokens are automatically replaced after errors.

## Recipient: manual input, preview, consent and accept

Only `no_active_pair` context exposes recipient controls. Typing a token does not
make a request. Explicit preview POST sends exactly `{token}`. A successful
preview is not a reservation, authority or membership, and does not imply consent.
The user separately chooses consent and explicitly accepts. Accept POST sends
exactly `{token, accept:true}`. Canonical token syntax is checked without Buffer
or custom cryptography; the server remains authoritative.

Editing input invalidates preview/consent, interrupts the old operation, and
suppresses old responses. A pending accept captures its approved token separately.
After a lost accept acknowledgement, explicit retry uses that same approved token
without requiring another preview, because the invitation may already be consumed.
Preflight may then be ready for the same session/domain user. The server must
validate replay of the exact token; another pair is never called this invite's
success. Session or domain-user changes terminally clear the operation.

Acceptance acknowledgement must match the captured session and domain user.
Returned pair/epoch never grants chat access. Only a fresh authoritative context
followed by existing chat discovery can do that. An uncertain 503, malformed body,
network error, cancellation or lost acknowledgement is not evidence of rollback.

## Clearing, privacy and failure behavior

Tokens, consent and pending commands live only in RAM. There is no token persistence,
SecureStore use, logging, analytics, clipboard, sharing, URL or deep-link flow.
The sole persistent credential storage remains the official SDK's existing store.

Logout, parent invalidation or changed scope resets all invitation state and the
parent's private draft/message queue. Cancel/unmount clears raw tokens and recipient
input/consent, aborts pending requests and suppresses late completion. It preserves
safe owner recovery metadata and an uncertain old revoke ID. A server transaction
may already have committed; cancellation does not undo membership or issuance.

Actions serialize through `busy`; duplicate presses cannot queue later work.
The UI blocks general refresh and waiting-space creation during an invitation
operation or uncertain accept. The parent also guards waiting-space creation.
Explicit cancellation/logout remain available. Calling the parent controller's
`refresh()` directly is an explicit context refresh and can reset invitation state;
it is not an exact-command retry and is not triggered automatically by invitation
preview, issuance, metadata read, or uncertain outcomes.

Known invitation denial uses `invitation_unavailable`. Unknown outcomes use
`invitation_retry_required`. Invalid manual syntax and absent consent use
`invitation_token_invalid` and `invitation_consent_required`. Authentication and
origin denials terminally clear state. Error text never identifies the other person.

## Verification and remaining limits

Run mobile `npm run typecheck`, `npm run lint`, and `npm test`; coverage continues to
include unimported runtime files with the existing global 90% thresholds. New
transport, consent-controller and await-boundary race suites are separate files.
They cover exact wire shapes, malformed/oversized/stalled responses, cookie/session/
user/pair/epoch changes, lost acknowledgements, old-revoke/new-invite races, input
edits, duplicate presses, generation changes, logout and cancellation.

The API PostgreSQL verification harness exercises this actual mobile controller
through the official Better Auth bridge, with synthetic data and loopback requests.
Aggregate results and exact revision evidence are recorded by the coordinating
verification pass. No unit/React test, JS export or PostgreSQL test is a native
build, two-device test, completed security review or production acceptance.

Production delivery, abuse/rate limits, production configuration and deployment,
native device verification, lifecycle/background behavior and independent review
remain separate work. No dependency, API migration or production server was added
by this client implementation.
