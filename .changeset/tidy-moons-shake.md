---
'@bevel-software/platform-core-frontend': patch
---

Retire the brand purple: every accent now resolves through the design system's
`accent` / `accent-hover` tokens instead of the off-system `--color-bevel*`
block, which is deleted. One accent colour where there used to be two competing
for the same job.
