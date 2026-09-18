---
'@bevel-software/platform-core-frontend': patch
---

Every action on a tool page's connection section is now one size. Set key and Add key were `sm`; Test connection, Open Secrets, Reconnect, Replace client secret, Replace, Remove, Set client secret and the setup banner's Edit the tool file were `tiny` — a smaller type scale and three pixels less vertical padding. The result was a row whose controls sat at two different heights, which reads as two unrelated kinds of control rather than one list of things you can do.

The size is the one Edit server and Save already use in the server section, so the two halves of the page now agree; nothing shrank to meet in the middle. Variants are untouched — a quiet button is still quiet, the banner's action is still primary — and the badges and the health line keep their own sizes, because only the buttons were inconsistent. The chips under "Powers these skills" keep theirs too: they are links into the library, not actions on this tool.

The section's test now asserts the size on every button and button-styled link it renders, across the whole row matrix: a settled tool, a tool waiting on keys, a pending sign-in, a sign-in to redo, an unfinished OAuth setup, and the editor's Save and Cancel. It reads the size tokens off `buttonClasses` rather than hard-coding a class string, so changing the padding scale moves the assertion with it instead of leaving it checking a size nothing renders.
