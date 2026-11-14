# Separation periods — bounded synthetic candidate

Basis: PRODUCT_BACKLOG P0 separations/countdown and TAN_ATA_MAP partings and management.
Base independently accepted 710a124. This is a separate resource from shared calendar dates.
No source personal data or original letter content is copied. Both current active members
have equal explicit create/edit authority; this is not a mutual-consent scheduling feature.

## Proposed frozen contract
- Explicit create/list/edit of all-day inclusive local date ranges (2000–2100), title
  and IANA zone. Period ending boundary is the first local day after the inclusive end; this is not a confirmed meeting.
- Store stable id and derived UTC start/exclusive end snapshots. Reject nonexistent or
  ambiguous boundary midnight rather than invent an offset. Local date arithmetic,
  not fixed 24-hour durations, drives days. Server asOf is explicit checked-at state;
  no device-clock authority or continuous/realtime countdown claim. UI explicitly calls endDate the last day apart; the derived end does not assert an agreed meeting.
- Intersecting inclusive date labels are disallowed within active couple epoch; actual
  UTC interval intersection is also disallowed across zones. Conservative date-label
  rule prevents accidental two separations for the same named days when zones differ.
- Complete bounded list of max100 records; create fails explicitly at capacity. No silent
  truncated history. No automatic generation, deletion, reordering of morning slots,
  numbering changes, prepared-letter mutation, or changes to release snapshots.
- Version CAS, immutable operation command identity and current canonical exact retry.
  Unknown ACK retains exact command; newer unsaved RAM is not silently erased.
- Active session/current couple/epoch authorizations after locks; pair serialization,
  database guards and concurrent tests enforce overlap. One pair cannot inspect another.
- No-op policy, SQL boundary conversion and exact response schema documented below
  once implementation is frozen; not accepted until author FULL11 and independent gates.

## Deliberate exclusions
No flight import/change, linkage or automatic numbering of letters, notifications,
GPS, consent inference, deletion/retention decisions, native/device/production/E2EE proof.
This does not complete P0 or Tan Ata parity. Production retention and native testing remain open.

## Gates
Focused API/domain/mobile coverage >=90% each metric; exact author FULL11 and separate
independent FULL11/adversarial review. Check DST/folds/gaps, leap/date boundaries,
no-current/upcoming/ended, overlapping edits/create races, scoped access/revocation,
immutable retry/lost ACK/newer input and unchanged existing morning letters. Source-only
restore/byte comparison and saved archive. External evidence: partings-validation/.

## Implementation details
- `endDate` is labelled last day apart; derived next-day boundary is explicitly the
  end of this period, not a confirmed meeting or itinerary. UI exposes checked-at time.
- Normalized unchanged edits still require current version and authorization, retain
  version and record their command. Real changes increment version exactly once.
- GET list returns `{partings,limit:100,asOf}`; mutation returns
  `{parting,commandId,replay,asOf}`. UTC boundary snapshots are part of canonical resource.
- Router remains opt-in `enableSyntheticPartings`; existing feature contracts unchanged.
- Unknown/stale/conflicting server data fails closed; UI never treats unchecked empty
  list as verified no-separation. Cancel does not undo an already submitted command.
- Initial strict validation resolves each range exhaustively at response boundary,
  never in render/on keystrokes. Measured cloud Node100 range validations2235ms;
  native performance and native timezone implementation have not been proven.

- A mutation ACK confirms only its canonical period, not the complete pair list.
  It clears list checked-at/countdown authority until an explicit successful GET.
