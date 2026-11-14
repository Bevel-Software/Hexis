---
"@bevel-software/platform-core-frontend": patch
---

In full screen, a PDF's or a spreadsheet's Download button sits beside the exit control instead of under it. The full-bleed surface keeps a 12px gutter and starts its toolbar level with the exit control, and the PDF and XLSX toolbars leave the control a slot at their right end while the file is in full screen, so Download is clickable across its whole width. Outside full screen nothing changes.
