---
"@bevel-software/platform-core-frontend": minor
---

An app that claims root folders (`AppDef.roots`) can keep the app's one sidebar on screens of its own. `KnowledgeSurface` takes two more props beside `roots`:

- `nav`: the app's navigation, drawn above its folders in the sidebar.
- `page`: the screen it shows in place of the file viewer at a location that is not a file. The surface is then the sidebar and that page, without the registry's panes (the chat pane among them), and no row of the tree is marked current. Leave it out at a file's location and the viewer and the panes are back.

For both props, `undefined`, `null` and `false` (or `true`) each mean "not given", so `nav={cond && <Nav />}` and `page={onFile ? null : <Page />}` render as without the prop.

Until now such an app had to draw a navigation column of its own, which stood beside the sidebar whenever one of its files was open, was not hidden by the toolbar's sidebar button, and did not become the drawer on a narrow screen.

A narrowed tree with `nav` above it puts a "Files" heading over its folders in place of the rule, and leaves out the "Company Context" heading while nothing is pinned. Without `nav` and `page` nothing changes: Knowledge and a narrowed surface render as before.
