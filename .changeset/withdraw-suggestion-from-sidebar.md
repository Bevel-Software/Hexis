---
'@bevel-software/platform-core-frontend': patch
---

A suggestion can now be taken back from the sidebar row that shows it. Right-clicking a proposed row — the accent-coloured one that appears when a file is uploaded into a folder the caller cannot write — offers **Withdraw suggestion**. It confirms first, naming the file, and then cancels the change request down the same author-cancel path the file page's change box has always used; the row leaves the tree on the refetch that follows, with no reload.

Withdrawal is per request, because that is what a change request is: a multi-file drop became one of them, and cancelling it cancels all of it. The confirmation says so rather than leaving it to be discovered afterwards — "This withdraws the whole suggestion: 3 files".

The offer is gated on authorship. Only a request the caller made carries the menu item; an owner looking at someone else's proposal is offered no Withdraw, and their "no" stays the Decline in the change-request dialog, unchanged.

The notice that announces a suggestion-routed upload now ends by saying where the undo is: "To take it back, right-click the file and choose Withdraw suggestion." It previously reported that the upload had become a change request and said nothing about reversing it, and the row it produced said nothing either — which is how an accidental upload came to read as permanent.
