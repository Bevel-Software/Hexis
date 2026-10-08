---
'@bevel-software/platform-core-frontend': patch
---

New changes from teammates are announced as "New changes available", never as a pull. When the automatic update fails the banner says "Couldn't get the latest changes" with an Update button (was Retry); on a draft it adds "Your draft doesn't have them yet."; with an unsaved page open it says "Save your open page to get them." The banner no longer shows the branch name or a merge icon.

The repository-problem banner reads plainly too: "Changes on `<branch>` are saved here but aren't reaching your git host. An administrator should check the server logs.", and a two-sided edit says "These pages were changed both here and on your git host. Hexis is trying to combine them." instead of talk of being "in sync" and "reconciling".

Settings → Deployment's sync panel is now "Updates from your git host": Update now (was Sync now), "Last update …", "No updates since this server started.", "Updated: …", the copy button is "Copy the hook address", and the secret is the "Hook secret".
