---
'@bevel-software/platform-core-frontend': patch
---

A long name picked in Manage access now stays inside the field. The chip is bounded by the box it sits in and its label truncates with an ellipsis instead of running past the chip's border; the remove button keeps its full size at the end, and the whole name is still there as the chip's tooltip and as that button's accessible name. What bounds the chip and truncates its label is sized in percentages and rem rather than pixels, so a long unbroken address and a 200% zoom both keep it intact.
