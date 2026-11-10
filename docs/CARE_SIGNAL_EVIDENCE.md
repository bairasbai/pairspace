# Synthetic care signal: verification record

Status: implementation verified locally; frozen-SHA independent review pending.
Source baseline: local `524844b6ff352afd96ee29c74a10d7185f1f301b`, tree
`60bb8e3e3e8413f7e7b0adf4ac961aa82c1ff357`, matching published baseline tree.

## Scope

A fixed «Думаю о тебе» / “Thinking of you” command between two active members,
not arbitrary chat text. Server acknowledgement means saved, never delivered/read.
Recipient explicitly asks for latest incoming signal; no automatic polling or push.
Default App remains the offline demonstration. Only explicit synthetic runtime wiring
and loopback-enabled API composition can exercise the connected path.

The 60-second product cooldown is not a claim of abuse protection. The 24-hour
visibility window is not deletion retention. Minimal signal/command records remain
for deduplication; a production deletion/retention decision is still required.
No location, presence, receipt, analytics payload, external notification provider,
real account data, deployment or original Tan Ata production access is involved.

## Commands and outcomes

Final implementation checks (2026-11-10), logs in the linked evidence directories (trailing whitespace normalized):
- Root `npm test`: passed, 9 tests. Root runtime sources unchanged.
- Root `npm run typecheck`: not run successfully; inherited root dependencies absent
  (`tsc: not found`). Offline restore also lacked a cached package. This does not
  represent a Next.js build pass; no further root graph installation is required.
- API: 181 tests passed; coverage statements 99.80%, branches 99.55%, functions
  100%, lines 99.86%. Typecheck/lint passed; safety harness 9/9 passed.
- Real disposable PostgreSQL 18.6: 94/94 passed, including real mobile controller
  over official session cookies and HTTP, same-command concurrent replay, new-command
  cooldown race, lost committed ACK, two-pair isolation, member-row replacement,
  expiry during pair lock wait, close and replay into a new pair.
  Logs: `docs/evidence/care-signal/` (generated command output).
- Mobile: 31 suites / 989 tests passed; coverage statements 97.45%, branches
  97.02%, functions 98.41%, lines 98.25%. Typecheck/lint and iOS/Android JS export
  passed (632 modules each). Logs: `apps/mobile/evidence/care-signals/`.

## Remaining gates

Independent review must target the frozen implementation SHA and rerun relevant
checks. No native iOS/Android builds, real two-device lifecycle/background testing,
physical accessibility/visual acceptance, production load/abuse testing, durable
restart recovery, production retention, deployment or external delivery is claimed.
JS export is not a native build. Synthetic fixtures contain no real personal data.

## UI wiring boundary

The connected synthetic panel contains a second, centered reuse of HeartButton.
Global App/Navigation central heart remains the original offline demo alert, even
when the synthetic connected panel is mounted. This slice does not claim that the
global navigation action sends a real signal. Its pulse and reduced-motion behavior
remain intact; the connected action adds disabled/busy accessibility semantics.


## Disposable PostgreSQL harness budget

The complete suite grew to 94 cases and measured 56.36 seconds inside the old
60-second outer budget. Only the outer GNU timeout is increased to 90 seconds to
allow initialization/CI variance; TERM and 10-second kill grace remain. Per-test,
SQL statement/lock, readiness and cleanup deadlines and destination guards are
unchanged. A safety test pins the 90-second invocation; full safety and PostgreSQL
suites are rerun after this harness-only change.

## Subsequent navigation slice
The historical UI boundary above is superseded by
[CENTRAL_HEART_EVIDENCE](CENTRAL_HEART_EVIDENCE.md). Global navigation now uses
the same care controller only with explicit synthetic injection. Default demo is unchanged.
