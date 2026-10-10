---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The chat view's embed token lives five minutes, and the view renews it itself when a call is refused.

A token `open_page` mints now expires five minutes after it was issued, down from one hour: it sits in the chat transcript, and whoever holds it reads and edits that one file as its user until it runs out. A token the Atlassian connector mints through `POST /api/embed/token` keeps its hour; that panel frames `/embed` and has no host to renew through.

When an embed call (load, bytes, lock, heartbeat, save, propose) is refused for the token, the chat view asks its host to call `open_page` again for its own path and heading (`tools/call`, app to host, over the chat's own connection and so as its identity), takes the token out of the `embedUrl` it answers, and runs the refused call once more. An open editor stays open on its draft, and a save or proposal refused for the token goes through on the retry. `open_page` echoes the `heading` it was given beside the `path`, so the view knows what to ask for.

The view declares no capabilities at `ui/initialize` and reads the host's `serverTools` from the reply: a host that says it runs no server tools for a view is not asked, and one that says nothing is asked once and its refusal taken as the answer. When no fresh token can be had — the host will not call, the call fails or answers no `embedUrl`, or `open_page` refuses because read access was withdrawn — the view shows the expired sentence as before, with an open draft kept on screen above it, read-only, to copy. One renewal per refused call: a second refusal in a row is the expired sentence, never a loop. The SPA `/embed` page has no host to ask and never renews; it shares the view's one other change, that an expired editor stops its heartbeat and re-lock and keeps its draft on screen, read-only. Token verification is unchanged.

Pictures a page shows are bytes under the token too: one that fails to load is checked, and when the token was the reason the view renews it once and the picture loads again under the fresh one.
