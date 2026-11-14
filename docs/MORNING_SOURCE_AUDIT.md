# Original source audit (code only)
Tan Ata exact4822e213e991f6e8c0177751e0fd6626b1f237bc:
- lib/partings.ts letterIsOpen uses the recipient city and configured delivery hour,
  not viewer zone or midnight. Parting day numbers reset per inclusive date range.
- lib/letters.ts morningOf separates arrived, missed and last actually available;
  before opening hour there is no missing/readiness disclosure.
- cardFrom does not fabricate a letter for a missing real record; future is sealed.
- Archive is newest-first and constrained to the period. Prepared bodies, optional
  photo and Bashkir text/translation are richer than this proposed narrow slice.
Links:
https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/lib/partings.ts
https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/lib/letters.ts

No original sample/personal letters or photos copied. Only code behavior informed design.
New implementation is independent: recipient-owned explicit preferences; individually
assigned immutable morning slots; no period/date numbering or automatic daily promise.
One-time ready fill, no late fill/edit/cancel, no photos/translation/discussion/delivery
notifications. Existing plain/scheduled letters remain unchanged. This is not restored
lost code and not complete Tan Ata parity.
