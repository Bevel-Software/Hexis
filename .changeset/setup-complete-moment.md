---
'@bevel-software/platform-core-frontend': minor
---

Finishing the Get set up list says "You're set up" before the column goes.

When the last step ticks, or on arrival with every step already done and never celebrated, the column shows a short completion state in place of the list: "You're set up", one line saying what is now true ("Your agent can read and write your knowledge base", or "Your knowledge base is ready" when no agent has called in yet, plus "and your team can join you" for an admin), and a Close button. It fades in gently, with no motion for anyone who prefers reduced motion. Close records it per account in this browser (`bevel.onboarding.setupCompleteClosed.<email>`), and the column does not come back, not even if a step later comes undone.

The admin's plugin and invite checks now count as answered as soon as they find a yes, so an admin whose last step was one of those sees the list finish rather than a column that never settles.
