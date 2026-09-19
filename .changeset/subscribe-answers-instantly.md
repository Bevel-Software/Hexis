---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

Subscribing to a locked plugin now answers at once and finishes the request in the background. The endpoint used to do all of its git work before replying: create the branch on the remote, clone the plugins repository for that branch the first time a person ever asked, write the access file, commit, push, and open the change request. A first request is a full clone, which takes many seconds on a real repository, and the button only greyed out while it ran — nothing said the click had been received.

The click is now recorded in a new `plugin_join_requests` table and answered from that record, typically in a few milliseconds. The branch, the clone, the grant commit, the push and the change request run afterwards. Nothing changes for a plugin's managers: the same branch, the same commit, and a change request identical in title, description and content to the one they see today.

The button reads "Requesting…" from the click and refuses a second one, and the "Requested" card appears on the server's answer — before the change request exists, which is correct, because the request is recorded. The plugin index reports the plugin as requested from that record, so a reload during the background work still shows the card.

A record is what makes the rest hold. A restart with a request still pending sweeps it at boot and either completes it or marks it failed, rather than losing a request the person was told had been sent. Two tabs clicking together resolve on the table's unique `(requester, plugin)` index, so there is one recorded request and one change request. And when the background work fails, the record carries the reason: the plugin page shows the button again above the sentence "Your request to join &lt;plugin&gt; could not be sent: &lt;reason&gt;. Try again.", and the next click retries that same record instead of opening a second request.
