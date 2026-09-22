---
'@bevel-software/platform-core-frontend': patch
---

Four small fixes to the Manage access sheet from customer feedback on core-staging.

- In the new-grant checklist, unticking Can edit (or Owner, or Can download) leaves Can read selected instead of clearing it too. Read was checked only because edit implied it, so turning edit off dropped the selection to nothing and dimmed Share; less than edit is read, and only the Can read item itself takes read away.
- Picking a person or group from the suggestion list puts the caret back in the field, so the next name can be typed without clicking into the white space first.
- The suggestion list no longer offers a principal that is already a chip in the field, and offers it again as soon as the chip is removed.
- A row's permission menu sizes itself to its items (up to a cap) instead of to the trigger, so an item that carries a note such as "from the whole workspace" keeps its label whole rather than showing "C…"; at the cap it is the note that truncates, with the full text on hover.
