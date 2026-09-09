---
"@bevel-software/platform-core-frontend": patch
"@bevel-software/platform-core-backend": patch
---

Walk people through Cowork and claude.ai with a screenshot of every screen.

The Marketplaces tab described the route in prose. It now runs the screens in
the order they happen, each with the control to click boxed in a screenshot of
it: register the deployment, connect your account, add the marketplace, install
the plugins.

The two registration steps happen inside Claude's admin settings, so they and
their four screenshots show only to admins here; everyone else gets the three
steps they can act on. Step 1 carries the registration credentials themselves
rather than a link to the Deployment page, so an Owner filling in Claude's form
never leaves the page. Those six fields now have one definition, shared with the
Deployment card.
