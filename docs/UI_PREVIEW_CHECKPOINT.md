# UI preview checkpoint — 10 November 2026

## Scope
The approved cream/terracotta concept is translated into a bounded Expo component
slice, not a finished application. No external images, fonts, SDKs or dependencies
were added. Main/Kimi and backend code remain untouched.

## Working interactions
- Primary navigation and the existing central heart remain available.
- Today opens letters and calendar; Together opens letters, calendar and memories.
- Us also opens memories. Visible Back and Android hardware Back return to the parent.
- Switching primary tabs discards nested route state but preserves the RAM draft.
- Calendar switches between sample plans and tasks; all sample content is labelled.
- RU/EN strings cover every new screen. Planned cards are non-interactive, not dead buttons.

## Not implemented
Real letters, media, schedules, invitations, games, mood, support, memories and editing
are not connected. No success/delivery states are fabricated. No network requests,
auth changes, billing or deployment were introduced. No personal data appears.
The approved concept's photography is not copied into source; simple native colour
surfaces are placeholders until licensed artwork and native visual QA are available.

## Verification
Typecheck, lint, Jest coverage and iOS/Android Hermes JS export are required locally.
Results are recorded in the handoff after final run. Unit tests cover sample routes,
RU/EN, repeated navigation, draft retention and hardware-back cleanup.
Native iOS/Android builds, real-device screenshots, screen-reader focus, font scaling,
keyboard and visual acceptance remain unverified. JS export is not a native build.
