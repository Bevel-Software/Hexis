---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The embed carries the seams a distribution with a knowledge graph needs, so it can retire its own copy of the embed and keep what its Atlassian issue panel does:

- A reference that is a bare node id (`/workspace/<branch>/<id>`, the app's copy-link form) resolves through `ports.embedNodeIdResolver`; core has no graph and still refuses such a reference when no resolver is registered.
- `IEmbedService.viewerOf(token)` answers who is looking through a token and at what — the linked user, their read and write verdicts, the file — so a distribution's own token-authed route beside the embed (the graph a dashboard draws) judges the viewer exactly as the embed does.
- A renderer that draws the knowledge graph asks its surface for it (`RendererSurface.loadKbGraph`), which the embed fills from the registry's `kbGraphSource` with its token; in the app the renderer reads the same source with the session. The renderer never picks an address itself.
- For a host that sizes its frame to the content, the embed posts its content height (`bevel-embed-height`) whenever it changes. Such a host asks by `sizing=content` on the view's address, which the connector's mint puts there; a host with a fixed reading pane, the MCP App's, keeps its pane and the view scrolls inside it as before.
