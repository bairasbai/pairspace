# Blind answers: synthetic connected slice

Explicit connected entry exposes one built-in bilingual question and one round per active
pair membership epoch. Opening is idempotent and cannot start another round after completion.
This is an early slice limit, not the final product policy.

No round requests happen on navigation, login, render, timers, or background events.
Open and refresh require explicit taps. No submission-status indicator is exposed.
Before both participants submit, only the viewer's own submitted answer can be shown.
Partner text is accepted only with a mutual-reveal response and a valid own answer.

The draft exists only in RAM. Changing it clears consent. An explicit consent switch and
submit button explain mutual disclosure and that submitted answers cannot be edited or
deleted in this slice. No keyboard-submit shortcut exists. Once submission starts, its
answer and command ID are immutable; retries reuse the same payload and prior consent.
The answer draft cannot be edited while that command has an unknown outcome. Refresh can
recover a committed answer but does not silently abandon an unresolved command.

Current session identity, generation, pair, epoch and cookie are checked before each request,
after headers and after response-body reading. Reset/leave/logout scrubs private state.
The client rejects foreign scopes, malformed/private metadata, changed round identity,
changed immutable own answers, and retracted mutual reveals. No text is stored in URLs,
logs, analytics or device persistence. Submitted text is server-readable, not E2EE.

RU/EN connected UI leaves default offline/Kimi behavior unchanged. Tests cover controller,
strict response validation, consent/retry, lifecycle races and connected component actions.
iOS/Android JavaScript export is not native build or real-device acceptance.
