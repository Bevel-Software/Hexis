---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-shared': patch
---

An applied change request stops showing as pending for everyone, not only for the person who applied it. The merge was already broadcast to every session, but only the clicking tab refreshed its lists, so the author's suggestion rows and every other viewer's tree markers stayed until a reload. Every tab now refreshes its change-request lists when a request is applied, declined or fails to apply, or when the event stream resyncs. If an event is lost, the tree re-reads the server on the review dock's 60-second window while the tab is visible, and as soon as a hidden tab is shown again. A failed apply is now saved on the request (new `change_requests.apply_failure_*` columns, migration `0008`) and announced with a new `change-request-apply-failed` event. The request stays open, and its author and other viewers see who tried to apply it and why, in the change-request dialog and on the change boxes. The event carries no error text, and the saved reason has credentials redacted.
