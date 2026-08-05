---
"@bevel-software/platform-core-frontend": patch
---

Put the app's notifications on the design system. The Library toast — the only toast in the app, and the surface behind ~16 different messages — hand-rolled a teal border and teal text from raw hex (`#7fd0c4` / `#0f766e`) on a bespoke shadow and an off-scale `12.5px`, which made every message in the Library the only teal thing on screen. It now uses the `Surface` primitive at `overlay` elevation, so its chrome comes from tokens. It also gained a tone: roughly half of those messages are failures ("Couldn't send that — try again.", "Blocked — the file changed after this was written.") and all of them were rendering in the same success-teal, so failures now read as failures. Tone colours the text rather than the surface, because a toast floats over arbitrary content and needs to stay opaque and legible — which is what `--color-ok` / `--color-danger` are specified for.

Four notification strips had the same problem from different directions, each on its own raw Tailwind palette while two siblings were already on tokens: the pull-needed banner (sky), the protected-branch banner (amber), the demo banner (solid indigo) and the roles-corrupted banner (solid red). All four now use the token tones, and their hand-rolled action buttons are the `Button` primitive. The pull-needed banner in particular stops being blue: blue is the app's single interactive colour, so a blue strip was competing with its own button — the strip is now neutral chrome and the accent lives on the action. The demo banner also distinguishes an expired demo (`danger`) from a live one (`wait`) instead of shouting the same note louder.

Takes the design-system ratchet's `raw-hex-in-class` count to zero.
