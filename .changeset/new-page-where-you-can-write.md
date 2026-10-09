---
'@bevel-software/platform-core-frontend': patch
---

New page creates the page where the person may write, and is not offered to someone who may write nowhere in Knowledge.

"Write your first page" in the Get set up list, and New page in the command menu, always created `Untitled.md` at the top of Knowledge, which only admins may write on a new deployment, so everyone else got "You don't have permission to write to … Eligible: Admin." Now the page goes at the top of Knowledge when the person may write there (admins, as before); else in the folder of the page on screen when they may write it; else in the first folder they may write, in file tree order — asked of the batch access endpoint once, and again whenever the file tree or the page on screen changes. Someone who may write no Knowledge folder sees neither the step nor the command (its C key does nothing), and the list counts and completes without the step; the list waits for the answer, so the step never appears and then vanishes. A write refused because access changed since the check asks again and moves to the next folder, or the step and the command go, with no permission text. With an agent connected, its first-page request names the folder when the page would go below the top of Knowledge ("write a page in Knowledge/Sales …").
