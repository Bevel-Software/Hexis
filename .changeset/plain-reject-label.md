---
'@bevel-software/platform-core-frontend': patch
---

Call rejecting a change request what it is. The review footer's "Send back with
a note" is now "Reject Change Request", its confirm button is "Reject", and the
toast reads "Change request rejected" instead of "Sent back to the author".

"Send back" described a handoff the product does not perform: closing a change
request writes the reviewer's note to `pr_comments` and flips the row to
`closed`, and nothing surfaces either to the author — closed requests drop out
of the for-me list, and no view renders those comments. Until that round trip
exists, the button should name the outcome the reviewer is actually causing.
