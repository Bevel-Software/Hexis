---
'@bevel-software/platform-core-frontend': patch
---

Four layout defects from Juan's 2026-09-22 pass on staging, all in the frame rather than in what the frame holds.

The sidebar's first row opened a band's height below the page title beside it on Knowledge and on Skills & Tools. `SidebarFrame` reserved the shared header band whenever a surface DECLARED a header, and both surfaces declare the connect-your-agent pill — which draws nothing once onboarding is done, so everyone who had finished setting the product up read a nav that started 48px below its own page title, under an empty strip. The band is now spent on a header that draws: `empty:hidden`, read off the DOM the same way the footer group below it already is. Note for any surface built on `SidebarFrame`: a header that renders nothing no longer buys a band, which is the intended rule — a surface that wants one passes content. The pill's dismissal receipt, an `sr-only` live region, moves to the body through a portal so the row it leaves behind is genuinely empty.

The file page in history mode took the full-bleed contract — right about the height a panel that scrolls inside itself needs, wrong about everything else: the column went with it, the title ran into the pane's left edge, the timeline started flush against it, and going to history and coming back moved every row on the page. `KbDocumentShell` grows a third variant, `panel`: the reading view's column (the 880px measure, the same side margins, the same offset the band opens on) with full-bleed's definite height. Switching between the document and its history now moves nothing but the content.

A plugin row's `Owner` chip travelled with the name and its counts travelled with the row's trailing group, so on any row with a description the chip sat up on the name's line at the left while the counts sat centred at the right. Chips, counts and access state are one group at the row's right edge now — one line, right-aligned, centred against the row whatever the height of the title block.

The tool page's `⋯` rendered as the last child of its `<header>`, under the back link and the description, left-aligned. It sits at the right end of the title row, in the group the plugin page puts it in.
