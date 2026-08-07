---
"@bevel-software/platform-core-frontend": patch
---

Roles & Members and "Manage access" stop overflowing on a phone. Both were laid out desktop-only — fixed pixel widths, single-line flex rows that never wrap, and `shrink-0` clusters starving a `flex-1` sibling — so at a 390px viewport controls escaped their containers and one of them deformed.

In "Manage access" the share row was explicitly `items-stretch`, and `Button` is `rounded-full`: the moment a chip wrapped the token box onto a second line the box grew, the buttons stretched to match it, and Share inflated into a circle. It was not a mobile-only bug — at desktop width the button measured 72x72, exactly square. The row is now `items-start`, so neither button tracks the box's height, and it wraps rather than crushing the input; `h-full` on the token box and the verb button went with it, since nothing stretches now.

The grantee rows had a worse failure. The meta cluster (via… / verbs / Remove) could not shrink, so it starved the name block to zero width — which left the `Role` badge, itself `shrink-0`, painted on top of the italic "via …" label, and pushed Remove past the panel edge where it could not be clicked. Rows now wrap with a floor under the name, so the name and its badge hold the first line and the meta drops below. A user with no display name also rendered their email as both the name and the subtitle; the duplicate line is gone.

In Roles & Members the add-member input was `w-64` inside a card with roughly 274px of content width, so the Add button spilled past the card border; the input is capped rather than fixed and its wrapper can shrink. The suggestion dropdown was `w-72`, also wider than the card, and now matches the input on mobile while keeping its width from `sm` up. Member chips and the rename row can shrink instead of overflowing, and `PageShell`'s header wraps so an expanded New role form drops below the title.

Measured in Chromium at 390px: the Add button went from 34.5px past the card to 0, Remove from 60.9px past the panel to 0, the grantee name from 0px wide to 262px, and Share from 59x66 to 59x28. One deliberate cosmetic change: with nothing stretching, the two buttons now sit at their natural height and are ~9px shorter than the token box in the empty state, top-aligned — the conventional treatment for a wrapping token field.
