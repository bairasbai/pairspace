# Repeatable blind answers: synthetic connected slice

Opening via the legacy endpoint always returns the first round; it never advances.
The separate explicit “Refresh round list” action retrieves only the latest ten round IDs
and question/version metadata, plus the server's current ID. This is not a complete
history. Selecting a listed round explicitly fetches its body. Ordinary “Refresh round”
refreshes the selected body. To find a partner's new round, refresh the list and select
“Current round”. No navigation, login, render, timer, or background event starts requests.

The three bilingual catalog questions have pinned IDs and catalog versions. After both
answers reveal, only the known current round offers buttons explicitly confirming a new
round with the full chosen question. There is no daily/automatic progression. Historical
rounds are read-only. After a next ACK/replay, refresh the list before further submission
or progression: the returned target does not prove that it remains server-current.

Before mutual reveal only the viewer's own submitted answer can be shown. Metadata never
includes body text or submission status. Partner text is accepted only with mutual reveal
and a valid own answer. Known immutable answers and reveals cannot be replaced/retracted.

Drafts exist only in RAM. Selection clears drafts and consent; editing also clears consent.
An explicit consent switch and submit button explain mutual disclosure and that submitted
answers cannot be edited/deleted in this slice. No keyboard-submit shortcut exists.
Once a command starts its ID, question/version and answer/predecessor stay immutable.
Unknown outcomes retain commands per round. Selection invalidates request generation, so
late answers or next ACKs cannot replace the selected round. Returning to the predecessor
restores its unresolved next retry; only a retry completed while still selected can show
its target. Retry uses exactly the same command and payload. Refresh does not silently
abandon unresolved commands. Known bodies are pruned outside the displayed/pending scope.

Session identity, generation, pair, epoch and cookie are verified before requests, after
headers and after body reads. Reset/leave/logout clears drafts, known bodies and commands.
No answer text is persisted in URLs, logs, analytics or device storage. The server can read
submitted text; this is not E2EE. Default offline/Kimi behavior remains unchanged.

Tests cover controller, strict response validation, rendered RU/EN actions, immutable
retry and lifecycle/selection races. iOS/Android JavaScript exports are not native builds
or real-device acceptance. Independent review is still required.
