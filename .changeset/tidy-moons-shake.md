---
'@bevel-software/platform-core-frontend': patch
---

Retire the brand purple: every accent now resolves through the design system's
`accent` / `accent-hover` tokens instead of the off-system `--color-bevel*`
block, which is deleted. One accent colour where there used to be two competing
for the same job.

Both accent tokens are darkened by 5 points of HSL lightness as part of the
move — `accent` #2383e2 → #1b76d0, `accent-hover` #1b74cb → #1867b4. The retired
purple cleared WCAG AA under `text-white` (5.14:1) and the prototype's blue did
not (3.88:1), so consolidating onto it would have taken those controls below the
4.5:1 their text-xs/text-sm labels need. The new value is 4.62:1 and also lifts
`text-accent` links, which sit on the same pair against white. Hue and
saturation are unchanged, as is the accent→hover gap.
