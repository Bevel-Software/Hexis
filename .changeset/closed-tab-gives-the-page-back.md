---
'@bevel-software/platform-core-frontend': patch
---

Closing a tab gives the page back, and a page held by you says so instead of naming you as someone else.

Closing, reloading or leaving the site while editing now releases the hold at once (a keep-alive request on `pagehide`), so Edit works immediately when the page is opened again. On that way out nothing unsaved is written: text typed since the editor's last automatic save is lost, as before, and the browser still warns first. Moving to another page inside the app is different: the editor saves what is pending before it lets the hold go, as it always did. Switching tabs or minimising the window keeps the hold. If the release never arrives, the hold ends at its expiry, as before.

When the hold is your own (another tab, a browser that closed without giving it back, your agent saving), the notice reads "You have this page open for editing somewhere else, in another tab or through your agent. You can edit it here in a moment." rather than naming you as another person. Someone else's hold reads as before. Either notice now goes away by itself when the hold is released or expires, and Edit is available without a reload. The server's rules for holds do not change.

One behaviour change to note: a hold of your own that is live elsewhere (another tab, your agent) used to be hidden, so the page looked editable until Edit failed. It now shows the self-hold notice as soon as the page opens, and Edit waits for the hold to end. The only own hold still hidden is this tab's own release or acquire while it is on its way; once that settles the page asks again, so a release that failed shows the notice instead of a page that looks free.
