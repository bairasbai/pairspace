# Private morning drafts — candidate, not accepted

Base: independently accepted synthetic checkpoint4d4ef80. P0 letters require a
private draft distinct from completed text. This first slice adds explicit server
save/load for an assigned morning; it is not full Tan Ata parity or production.

## Contract
- Only the slot's original sender, with active session/current pair epoch, can read
  or save. Recipient DTOs, canonical content, opening and prepared editing stay intact.
- `GET /v1/couples/:couple/mornings/slots/:slot/draft` takes membership_epoch/read_id.
  `PUT` takes membership_epoch, command_id, expected_version and body, with matching
  Idempotency-Key. Response binds read/command identity and contains serverNow, own
  slot metadata, body and version. Missing draft is null/version0, not an empty letter. A filled slot with no existing
  draft reports slot_filled, not an authorization failure.
- Initial draft creation requires an unfilled slot. It can be saved after the morning
  deadline: a missed morning remains missed. Existing drafts survive later fill and
  remain explicitly readable/editable; they do not change that prepared letter.
- Positive CAS versions protect competing writers. An unchanged normalized save does
  not advance version. Immutable command fingerprints contain no historical plaintext;
  exact retry returns current canonical draft, never overwrites newer saved text.
- No automatic save, fill, publication, completion, deletion, notification or release
  worker. Existing fill remains explicit and separately confirmed. Neither save nor
  loading copies the draft into the fill composer or prepared editor.

## Storage and safety limits
Text is stored server-side in plaintext protected by author ACL, not E2EE. This is
synthetic data only. Access after membership ends, retention, export, backups and
server deletion require separate policy/work; this slice promises none of them.
No clear/delete control is added. Closing the form is not deleting the saved draft.
An unsaved edit still exists only in RAM and can be lost when the session/app closes.
Offline durable storage, real device restart and restored-key safety are unproven.

The separate editor protects newer RAM input from old reads/ACKs and requires explicit
Save. A conflict preserves input and requires reload. An unknown save outcome retains
its exact immutable command, blocking fresh writes and reload until explicit retry.
Session/pair change clears private projections; stale responses cannot restore them.
Current-session authorization denial remains effective even from an obsolete read.

## Verification
Implementation and focused tests in progress. Author frozen FULL11 and independent
exact-SHA review required. Evidence and archives live outside source checkout.
No native iOS/Android, production, E2EE, GitHub publication or server deletion claim.

### Focused author evidence before frozen gate
Mobile2341 tests passed without coverage; dedicated16 tests cover all three new
modules100% in all four metrics. API16 focused tests passed; changed backend modules
100% statements/lines/functions and93.63% branches (HTTP91.15% branches). Typecheck
and lint passed; two baseline mobile import warnings remain. Real PostgreSQL/HTTP
connected2 tests passed CAS/no-op, receipt rollback, lost ACK/exact retry, newer RAM
input and canonical-letter isolation. Full production coverage still needs its gate.

Initial PG run failed because fixture did not register migration028; registration
fixed and the original failing log preserved. A new revoked-member unit fixture first
violated the existing active-pair-two-members invariant; fixture closed the pair before
revocation rather than weakening the guard. Initial narrow diagnostic HTTP coverage
was below threshold; the fuller focused test set closes it without coverage exclusions.
None of these focused checks constitute independent acceptance or native proof.

## Subsequent terminal-removal candidate
The no-server-delete statements above describe accepted53a1734. A separate v2
candidate now adds explicit logical removal of a saved draft with a retained terminal
marker. It does not promise physical backup erasure or restoration/recreation.
See [MORNING_DRAFT_REMOVAL](MORNING_DRAFT_REMOVAL.md); exact acceptance is separate.
