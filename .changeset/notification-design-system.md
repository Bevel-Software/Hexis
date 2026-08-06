---
"@bevel-software/platform-core-frontend": patch
---

Put the app's notifications on the design system. The Library toast — the only toast in the app, and the surface behind ~16 different messages — gains a tone: roughly half of those messages are failures ("Couldn't send that — try again.", "Blocked — the file changed after this was written.") and every one of them rendered identically to a confirmation, so failures now read as failures.

Tone colours the PLATE, not the text, which is the opposite of `Banner` (`bg-*-soft text-*`). The inversion forces it: the toast is an ink pill, and `--color-ok` on `--color-ink` is a 2.4:1 contrast ratio (`--color-danger`, 1.9:1), so tone-as-text is unreadable here however well it works on a light surface. Against canvas text the three plates run 12.3:1, 5.1:1 and 6.5:1, all clear of 4.5:1, and the pill stays one inverted shape across every tone instead of flipping to a light card for errors.

Four notification strips had the same problem from different directions, each on its own raw Tailwind palette while two siblings were already on tokens: the pull-needed banner (sky), the protected-branch banner (amber), the demo banner (solid indigo) and the roles-corrupted banner (solid red). All four now use the token tones, and their hand-rolled action buttons are the `Button` primitive. The pull-needed banner in particular stops being blue: blue is the app's single interactive colour, so a blue strip was competing with its own button — the strip is now neutral chrome and the accent lives on the action. The demo banner also distinguishes an expired demo (`danger`) from a live one (`wait`) instead of shouting the same note louder.

Keeps the design-system ratchet's `raw-hex-in-class` count at zero — the toast's own four raw hexes were already retired on `dev`, which rebuilt it as the prototype's ink pill; this change layers tone onto that pill rather than restyling it a second time.
