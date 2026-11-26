---
'@bevel-software/platform-core-frontend': patch
---

Picking a set on a "Denied here" row in the share dialog lifts the whole Deny first, then writes back only the denials the set still needs (a verb a parent grants that the set leaves off). Before, the download and owner denials stayed behind after picking Can edit, so a later download grant at the parent was still refused below. While the writes run, the person briefly holds what the parent grants them; if a write after the lift fails, the dialog writes the whole Deny back, and if that fails too its error says the Deny was not put back.
