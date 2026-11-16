# Personal capsule client bounded acceptance, 16 November 2026

Status: independently accepted synthetic client/controller/test-harness slice. Based on server source
f81097cc and docs326c3e8. No server contract or migration changes in this stage.

## Interaction and privacy contract
- An explicitly injected synthetic-loopback runtime exposes a personal capsule tab.
  The ordinary disconnected preview remains unchanged and makes no requests.
- Metadata is personal, not shared with the partner. Even the author cannot fetch
  or display the stored text before the server-confirmed release time.
- Explicit load/create/reseal/read/remove; no background polling, automatic resend,
  device-clock opening or push claim. Every network action rechecks session context.
- Complete date/time/IANA-zone/offset selection; next-calendar-year suggestion uses
  the selected zone and last server check, never device time. It is a suggestion,
  not an authorization or automatic submission.
- Create, replace and remove require an explicit confirmation bound to current
  controller generation, metadata version and form revision. Replacement supplies
  new text and a future schedule, allowed only before the OLD server deadline.
- A command with unknown outcome is immutable and manually retryable while the
  same screen and authenticated scope remain active. Editing the form cannot alter
  that command. ACK/replay is metadata-only; reading always uses a separate request.
- Leaving the screen or backgrounding clears draft, reader AND retained command
  payload, discards late responses and requires a fresh metadata check. A sent
  operation may already have committed; clearing does not undo it. No automatic
  replacement command, hidden payload restoration or text recovery is attempted.
- Account, cookie, pair, epoch and controller replacement fences scrub private state.
  No private-text cache, analytics or logs; RAM-only handling is not an E2EE claim.
- Removal erases server body but keeps the sole slot in the current pair epoch.
  Post-separation access remains unresolved and denied by the existing contract.

## Verification plan and limits
Planned gates were controller/proof/parser tests, RU/EN iOS/Android component harness, stale confirmation,
offline/unknown ACK/retry, background/unmount/logout and real HTTP/official auth/
PostgreSQL integration, followed by exact frozen FULL11 and independent review.
Coverage must include all production files and retain all four global90% floors.
Native screenshots, keyboard on-device, screen reader, two devices and actual native
runtime are NOT_RUN unless separately evidenced. Jest platform mocks and JS exports
are not native/device acceptance. No production deployment or E2EE verification.
GitHub publication remains blocked awaiting explicit owner approval. Separate local
commits and Library backups are the permitted checkpoints; main is untouched.

## Focused checkpoint before full verification
- New client tests48/48 PASS across controller/state/proof/panel/composition.
- Six new production files: statements96%, branches94.14%, functions95.65%, lines99.50%.
  Controller individually exceeds90% across all four metrics; state/proof/reader/copy100%.
- Actual mobile-controller → HTTP → official Better Auth → PostgreSQL scenario1/1 PASS,
  including lost create/reseal ACK after another client reseals, and lost removal ACK
  discarded on leaving followed by metadata reconciliation. No text in ACK/list/replay.
- Initial real HTTP scenario failed at the old keep-pending-on-unmount behavior;
  the clarified all-payload scrub boundary was implemented and the rerun passed.
- Initial local coverage invocation used the wrong root-relative glob (zero files).
  It is not coverage evidence; the corrected invocation includes all six new files.
- UI harness simulates both platforms and languages, with background/unmount cleanup,
  stale form/version/controller confirmations, duplicate taps and offline/error states.
- Current selected cloud environment has no adb/emulator/xcodebuild on PATH and no
  /dev/kvm. No available Android SDK tools were found in workspace/tmp/opt checks.
  The historical Android1762854 build does not verify this client revision. Native
  builds/runtime/screenshots/accessibility/keyboard device checks remain NOT_RUN.

Physical memory zeroization and OS/network-buffer erasure are not claimed. Already
transmitted requests may have committed before cancellation; clearing app state cannot
undo them. Privacy tests establish no retained retry capability or late visible state.
API/mobile typecheck and lint PASS; three pre-existing unrelated mobile test warnings
remain, with no new lint errors. Exact FULL and independent review were pending then.

## Review correction before acceptance
Parent review, independently confirmed, found that the submitted draft remained in
TextInput until ACK. A committed seal with a lost ACK therefore left the original
text visible before the deadline. Create/reseal now synchronously clear the submitted
visible draft before any request; only the private mounted retry payload remains.
Invalid/transport errors do not restore submitted text. Later distinct composer edits
retain their own revision. Controller regressions cover both held/lost create and
reseal ACKs; actual HTTP assertions check hidden draft after committed lost ACK.
The initial FULL on d20305d was stopped (exit130) after this finding. Its report
`/tmp/pairspace-verification-uvNlk8/report.json` is incomplete/RUNNING with
acceptance=false and is NOT full-verification evidence. The correction was followed by a new
exact freeze, FULL and independent review below; no accepted server code changed.
Corrected focused run54/54 PASS; all six files coverage96.02/94.40/95.65/99.50%
(statements/branches/functions/lines), controller individually95.05/91.74/92.30/99.30%.
Actual HTTP/auth/PostgreSQL mobile scenario rerun1/1 PASS with the draft-hide checks.


## Final exact-source bounded acceptance
Author and independent reviewer both passed all 11 required FULL gates on
`1e92e3a639f0f2d5dd6baed53a76ed0a42823411`, tree
`fe64346769adc88d66f895ec23d9647c460c7d49`. Both report sourceValid=true and
clean unchanged source. This later checkpoint changes only documentation.
- Author report: `/tmp/pairspace-verification-khOkgd/report.json`.
- Independent report: `/tmp/pairspace-verification-Z908Hr/report.json`.
- Both: API642/642 (91 files), mobile2862/2862 (173 suites), PostgreSQL451/451,
  no skipped PostgreSQL tests. Legacy Next build/typecheck intentionally NOT_RUN.
- API coverage: statements98.60%, branches97.46%, functions99.88%, lines99.45%.
- Mobile coverage: statements95.63%, branches95.29%, functions96.11%, lines97.38%.
- Reviewer verified the submitted-draft privacy correction and found no remaining
  blockers within this bounded synthetic client/controller/test-harness scope.

Native runtime, screenshots, physical-device keyboard/accessibility and two-device
scenarios are NOT_RUN and NOT accepted. The historical Android build and current
JS exports do not establish those gates. No production readiness or E2EE claim.
GitHub publication still awaits explicit owner approval; no GitHub, main or production
changes were made. Library packaging is coordinated separately. Report paths identify
local evidence, not durable user-facing download links.
