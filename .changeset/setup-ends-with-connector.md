---
'@bevel-software/platform-core-frontend': patch
---

The Claude setup walkthrough now ends where the setup actually ends. Installing **Hexis all** brings the skills and leaves the knowledge base disconnected: the plugin's MCP server is a connector Claude adds separately, and both routes stopped one step short of saying so. Both now end on that step — open the plugin's tools-and-data-sources list, where the `hexis` row reads **Not added**, choose **Add for your team** to get Claude's **Add custom connector** dialog already filled in, **Continue**, and approve the sign-in here. The step names its own check: the row no longer reads Not added. A reader without organization-admin rights in Claude is told they are offered the connector for themselves instead, or can ask an admin to add it for the team.

Both carousels render the SAME slide definition, so the two copies cannot drift. That mattered enough to be the reason it is one definition: the admin's copy is the one nobody rereads.

The registration steps in **Deployment → Marketplace** were an ordered list with four full-size screenshots stacked down it. They are a carousel now, on the shell the personal tutorial already had — progress strip, Back / Next / Review again, arrow keys and Home/End, one slide mounted at a time — extracted into `SetupCarousel` rather than copied. Keys that cannot move the carousel (Left on the first slide, Right on the last) are left to the browser rather than swallowed, so a reader who tabbed onto a screenshot link keeps the default scroll.

The generated credentials move with the carousel. They were gated on the drawer being open; they are now gated on the drawer AND on the Add-configuration slide being the one on screen, so a client secret is not in the DOM of the four slides that have no use for it.

The connector step's two screenshots are **drawings of the screens, not captures** — the flow was not in front of a camera when the step was written. Rather than leave that in a repo README, the page says so: a shot marked `illustration` prints a line under its frame telling the reader the detail on their own Claude may differ and that the instruction names the row and the control to look for. The nine real captures carry no such line. Replacing a drawing with a capture means deleting the flag and re-measuring its callout boxes.

`docs/claude-cowork.md` gains the same step, its verification line, and a troubleshooting paragraph telling a connector that will not attach apart from a marketplace that will not sync — the first is an MCP session against `/api/mcp`, the second is Claude's servers fetching over git.

No backend change, and nothing touched in the marketplace compiler, the **Add to Claude** install link, or the registration mechanics.
