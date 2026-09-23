---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A linked skill's plugin grants are written back the moment a plugin writer opens the plugin page, and a link is broken whenever those grants are absent.

`granted` used to mean "the plugin's members can read the skill", which a public repository root made true of every link — including one whose skill named no plugin at all, so nothing was ever flagged and the link worked only by accident. It now means what the link actually writes: the skill ROOT's own access file carries `plugin/<Name>/read` and `plugin/<Name>/write`, with a grant inherited from a folder above, or a `deny` at the root or below it, counting for nothing.

Opening a plugin's page as someone who may write the plugin now repairs, through the same write the Repair button uses, every link that lost its grants and whose skill access file that person may also write — silently, as ordinary commits in their name on the default branch (`POST /api/plugins/:name/links/repair-all`). A root that already carries both lines is not rewritten, and one repair failing costs the others nothing. What is left names itself: "<skill> can't be read by <plugin>'s members. <editors> can repair the link from the skill page." A viewer who cannot write the plugin triggers nothing and sees the banner as before.
