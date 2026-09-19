---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

Subscribing to a locked plugin now answers at once and finishes the request in the background. The endpoint used to do all of its git before it replied — create the branch on the remote, clone the plugins repository for it, splice the grant into the plugin's `access.md`, commit, push, open the change request — and the first request from a person is a full clone, which is many seconds on a real repository. The button greyed out and said nothing, so the click read as a freeze.

It is now two halves. The page acknowledges the click in the render that follows it: the button reads "Requesting…" and refuses a second click until the server answers. The server records the request in a new `plugin_join_requests` table and answers — a database round-trip, no git — and the page shows the "Requested" card on that answer. The branch, clone, grant commit, push and change request happen afterwards, against the recorded row. Nothing changes for the plugin's managers: the change request is identical in title, description and diff, and they settle it exactly as before.

The record is what makes the rest hold. The plugin index reports a plugin as requested from the row, so a reload one second after the click still shows the "Requested" card even though the change request may not exist yet. The row is unique per (requester, plugin), so two tabs or two clicks leave one request and open one change request. A row still pending at boot is swept and either completed or marked failed, so a restart cannot lose a request that was already acknowledged. And when the background work fails, the row records the reason: the next load hands the person the button back under the sentence "Your request to join &lt;plugin&gt; could not be sent: &lt;reason&gt;. Try again.", and clicking it revives the same record rather than opening a second request.

`PluginSummary` gains `requestFailure`, `POST /api/plugins/:name/join-request` answers `{ ok, state, number }` with `number` null until the change request exists, and `createPluginsRoutes` takes the new `PluginJoinRequestJobs` in place of the workspace service and KB directory name it no longer writes through.
