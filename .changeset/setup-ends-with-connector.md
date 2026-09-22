---
'@bevel-software/platform-core-frontend': patch
---

The Claude setup walkthrough now ends where the setup actually ends. Installing **Hexis all** brings the skills and leaves the knowledge base disconnected: the plugin's MCP server is a connector Claude adds separately, and both routes stopped one step short of saying so. Both now end on that step — open the plugin's tools-and-data-sources list, where the `hexis` row reads **Not added**, choose **Add for your team** to get Claude's **Add custom connector** dialog already filled in, **Continue**, and approve the sign-in here. The step names its own check: the row no longer reads Not added. A reader without organization-admin rights in Claude is told they are offered the connector for themselves instead, or can ask an admin to add it for the team.

The registration steps in **Deployment → Marketplace** are a carousel now, like the personal tutorial — progress strip, Back / Next / Review again, arrow keys — instead of an ordered list with four full-size screenshots stacked down it. The generated client secret is shown only on the slide that uses it. The connector step's two screenshots are drawings of the screens rather than captures, and say so under the frame.

`docs/claude-cowork.md` gains the same step, its verification line, and a troubleshooting paragraph telling a connector that will not attach apart from a marketplace that will not sync.
