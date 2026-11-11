# Optional song links: verification candidate

Baseline local b7a955a9be5a5c5db907032503bfadfafeeab3bd (published equivalent
 db28bcda9490e022cac3801bc56ea639539e518f). Isolated pairspace-song-links worktree.
Default demo, main, Kimi, production and user computer untouched.

## Scope and contract
See [shared songs](SHARED_SONGS.md). Optional explicit HTTPS link, immutable
create/read/retry, additive migration017 and unchanged no-link shape. Five exact
public hosts and deliberately narrow ASCII paths, no normalization surprises.
No fetch, preview, streaming, download, lyrics, account integration or dependencies.
Server stores plaintext; no E2EE or verified licensing/site-safety claims.

Installed React Native Libraries/Linking/Linking.js documents openURL as a promise
that rejects if the OS cannot open a URL. HTTPS is supplied explicitly. Only an
explicit button press invokes it on iOS/Android, with a leaving-app/data-collection
notice and complete URL. No canOpenURL/query-scheme permissions or clipboard writes.
OS acceptance is not evidence of destination content/loading. Rejection and rapid
repeat are handled; unmounted completions are discarded. Other platforms disclose
unsupported opening. Tests mock Linking: no external navigation takes place.

## Acceptance coverage
- Domain rejects control chars, credentials, private/unknown hosts, other schemes,
  ports, Unicode, backslashes, percent escapes, queries/fragments and overlength.
- API/SQL enforce same format; migration preserves pre-link immutable rows/receipts.
- Real synthetic mobile→HTTP→PG covers optional link, committed lost ACK, immutable
  retry, later draft preservation, partner read, foreign pair and closure cleanup.
- Mobile covers changed consent, stale session/user/pair/epoch, malformed linked
  ACK, clear-and-retype, RU/EN form/disclosure, explicit OS calls, denial and repeat.
- Existing privacy/race/no-link scenarios remain part of the full gate.

## Verification protocol
Status: candidate, NOT independently accepted. Freeze a clean SHA before the
fail-closed scripts/verification eleven-stage sequential full run, with all own
production files included and >=90% statements/branches/functions/lines.
Pinned existing dependencies physically copied; scratch TMPDIR/temp HOME; Metro
max-workers=2. Report and logs outside source, exact SHA and checksums to coordinator.
Native iOS/Android, device navigation/two-device E2E, legacy Next: NOT_RUN.
JS export is not native verification. No production/paid/preview/external requests.
Final runner outcomes are reported separately, not presumed from test presence.

## Initial diagnostic run
First frozen candidate c061479: 10/11 stages PASS, API typecheck FAIL due only to
three test accesses on unknown Response.json(). Fixed with explicit test response
type; no production behavior changed. Both coverage gates and real PostgreSQL
passed; PG duration 236.714s under the unchanged inner 240s guard. All eleven
stages must rerun on the corrected frozen SHA before acceptance.
