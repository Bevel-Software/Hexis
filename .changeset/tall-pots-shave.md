---
"@bevel-software/platform-core-frontend": patch
"@bevel-software/platform-core-backend": patch
---

Walk people through Cowork and claude.ai with a screenshot of every screen.

The Marketplaces tab used to describe the route in three sentences, in the
wrong order: it had people paste the marketplace URL first and wait for Claude
to ask them to connect, which Claude never does. The drawer now runs the four
screens in the order they happen, each with the control to click boxed in the
shot, and the connect step comes first.

The two registration steps happen inside Claude's admin settings, so they and
their screenshots show only to admins here; everyone else gets the three steps
they can act on.
