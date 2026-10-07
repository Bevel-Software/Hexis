---
'@bevel-software/platform-core-frontend': minor
---

A new knowledge base asks its admin "What does your team do?" and fits the first page to the answer.

While `GET /api/onboarding/starter-packs` offers it (an admin, nobody has answered, the knowledge base still new), the knowledge base's empty state is a card instead: "What does your team do?", "We'll add starter pages and skills that fit.", a chip per pack in the server's order (Engineering, Sales, Support, Operations, Something else) and a quiet "Skip, I'll start from scratch". A chip says "Adding…" while its pack lands, a refusal is said on the card in the server's words, and on success the file tree is fetched again and the ordinary empty state comes back with "Added 4 pages and 4 skills for Engineering." above its suggestions. Members never see the card.

Once a pack is chosen, the Get set up list's "Write your first page" uses the pack's own request (for Sales, filling in the Customers page) in Ask Claude, Ask ChatGPT and Copy prompt, and the pack's pages do not tick the step while they are still placeholders; the step ticks when one is filled in. `useStarterPacks()` (`modules/onboarding/state/starter-packs.ts`) shares the answer between the two, and `firstPagePromptFor(pack)` picks the request.
