---
'@bevel-software/platform-core-frontend': patch
---

The pointer turns into a hand over everything that can be clicked.

Tailwind v4 gives buttons the browser's plain arrow, so cards, tabs and text-styled links built from buttons looked like text under the pointer. One base rule in the app stylesheet now covers buttons, `role="button"` elements, summaries, selects, checkboxes, radios and their labels, on every screen. Disabled controls keep their not-allowed cursor.
