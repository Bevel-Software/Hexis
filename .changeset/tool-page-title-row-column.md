---
'@bevel-software/platform-core-frontend': patch
---

The tool page's title row now runs the width of the shared document column, so the `⋯` at the end of it lands where the plugin page's and the skill page's trailing controls do. The page wrapped itself in a second, narrower measure (`max-w-3xl`, 768px) inside the Library layout's 800px line, and the 16px that left on each side held its menu 16px short of the other two at every viewport — the same band, the same group, the same component, in a different place on the screen. The layout's `<main>` already holds the measure, as the skill page's column comment says, so the page keeps none of its own. The test helper the three item pages share asserts the column now as well as the structure: placement inside the row was already pinned, and both pages passed it while rendering apart.
