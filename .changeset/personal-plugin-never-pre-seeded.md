---
'@bevel-software/platform-core-backend': patch
---

Nobody can set up a person's personal plugin folder before they have. A write into a `Plugins/personal-<id>/` folder that has no `access.md` yet is refused for every caller, an Admin included and the `access.md` rescue too, in any casing of the folder name; only the owner's `my_plugin` creates the folder. When `my_plugin` finds the folder already there with an `access.md` that grants anyone besides its owner, or with none, or one that does not parse, it rewrites the rules to the owner-only template a new folder gets, commits that, and answers `repaired: true`. The folder's other files are left as they are. The template no longer suggests sharing the folder, since the next `my_plugin` call takes any other name back out.
