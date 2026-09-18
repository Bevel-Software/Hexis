---
'@bevel-software/platform-core-backend': patch
---

Word extraction no longer fuses the words around a soft line break or a tab: a `<w:br/>`/`<w:cr/>` inside a paragraph now reads as one space and a `<w:tab/>` as one tab (PowerPoint `<a:br/>` likewise reads as a space), so "however", soft break, "suits" extracts as "however suits". Runs otherwise still join with no separator. The extraction schema moves to `v3`, so cached extractions refresh. The file readers' README documents two accepted limitations: PDF ligatures can split a word ("fi le"), and Word heading styles are not marked.
