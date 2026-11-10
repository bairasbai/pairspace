# Synthetic care signal client

Status: implementation awaiting independent review of the final commit.
Only injected synthetic-loopback configuration can use this path. API composition
must explicitly enable `enableSyntheticCareSignals`; disabled server routes display
an unavailable-feature message. No production service or notifications are connected.

## Explicit actions and truthful states

The connected chat panel reuses the existing pulsating `HeartButton`, including
reduced-motion support, and adds accessible disabled/busy states. RU/EN labels cover
sending, uncertain acknowledgement/retry, saved-on-server, cooldown and unavailable.
Saved does not mean delivered or read. A separate explicit button retrieves the
latest incoming signal. Login, refresh and background work never fetch care signals.
The signal is fixed `thinking_of_you`, with no free-form text, location or presence.

`App.tsx`, `Navigation.tsx` and default offline demo routing are unchanged. The
original central navigation heart still opens its honest demo notice. The separate
connected panel heart performs the test-server action; this is not a new production
navigation flow. Native device design/accessibility acceptance remains outstanding.

The server's 60-second limit is a product cooldown, not proven abuse protection.
The 24-hour incoming visibility window is not a deletion/retention policy. This
client does not persist signals, credentials, outgoing commands or recipient state.
Leaving the connected screen or signing out clears ephemeral state. Unknown-ACK
retry survives only while the same controller/scope remains active, not app restart.

## Scope and replay safety

Care state is separate from chat and invitation state. Each explicit request first
binds a fresh provider session context to the captured identity, user, couple and
membership epoch. Cookie equality is checked before mutation, after response and
after bounded JSON parsing. Generation and scope checks discard late responses.
Author/recipient/command/couple/epoch/type are validated before displaying an ACK.
An incoming signal must target the current user and come from another user.
Server-side membership/session enforcement remains the authority.

Only one care request runs at a time. Repeated taps during a request do nothing.
Unknown responses retain the exact command UUID for explicit retry. A confirmed
ACK or definitive cooldown clears it; the next send generates a new UUID. Reading
incoming state does not discard a pending unknown-ACK command. Scope changes,
auth denial, logout and dispose clear pending and displayed state.

## Verification

- Jest covers RU/EN panel and connected-controller behavior, repeated taps, lost ACK,
  cookie replacement, malformed/cross-scope responses, late replies, cooldown,
  disabled API feature, explicit retrieval, no self effect and logout reset.
- `services/api/tests/postgres/mobile-care-signals.integration.mjs` exercises the
  real mobile controller, official provider cookie, loopback API and disposable
  PostgreSQL with two independent pairs, same-ID replay after committed lost ACK,
  one database row, foreign-pair denial and epoch reset.
- Full mobile coverage includes all production files. Logs are in
  `evidence/care-signals/`. Expo export is JavaScript bundling for iOS/Android,
  not a native build, simulator run, device acceptance or push-delivery test.
