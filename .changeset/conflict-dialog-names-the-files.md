---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': patch
---

When opening a change request runs its update from the target and the server refuses that update on conflicts, the dialog now names the files the server reported. The banner lists them under "The file(s) that can't be combined", by the name the file tree shows (the full path on hover), the tree marks the rows of those files, and the prompt the banner offers to copy lists their full paths in a data block of their own, marked as data and not instructions. Before, the dialog dropped the list the refusal carried, and neither the banner, the tree nor the prompt said which file conflicted. A refusal from an apply attempt reaches the dialog without a file list, so it names no file, as before.

The prompt now keeps a backtick in a branch or file name as it is, inside a longer code-span fence, where it used to replace it with an apostrophe and so name a branch or file that does not exist.

`@bevel-software/platform-shared` exports `markdownCodeSpan`, the quoting the agent instructions already used for the default branch's name, moved there from core-backend so the prompt above quotes names by the same rule. The agent instructions' text is unchanged.
