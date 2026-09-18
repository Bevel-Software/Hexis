---
'@bevel-software/platform-core-frontend': patch
---

On the first-run setup screen and in Deployment settings, "Save and continue" now sits below the Marketplace section rather than above it, and is aligned to the right of its row. Previously the page looked finished at the button while an entire section still sat underneath it, so an admin could commit to the next screen without ever meeting Marketplace. The button still belongs to the settings form and still saves exactly what it saved before; it is tied to the form it now sits outside of by the `form` attribute, which keeps Marketplace deliberately out of that form, since nothing in it is saved by this button.

The "Skip for now" control and its "Nothing else waits on it" line are gone, along with the skipped state they led to. Nothing waits on the Marketplace section either way, so an admin who does not want a marketplace simply walks past it, exactly as they walk past single sign-on by leaving it blank. Offering a button to decline it only added a decision nobody had to make, and a second thing to undo. The section keeps its Optional marker on first run, and it still fetches no credentials until its drawer is opened.
