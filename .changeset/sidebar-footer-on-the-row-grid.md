---
'@bevel-software/platform-core-frontend': patch
---

The two rows at the bottom of the sidebar sit on the sidebar's own grid. The "2 integrations need setup. Finish now" reminder and the CHANGE REQUESTS row each brought a left inset, a hairline and a margin of their own, and the three answers disagreed: the reminder pressed against the top edge of the dock, under two rules with no gap between them, four pixels right of the tree rows they hang beneath.

The frame now owns the bottom of the column. `SidebarFrame` renders its `footer` as a GROUP — one rule off the tree, one gap between whatever is inside it — and exports `SIDEBAR_ROW_INSET`, the single declaration of the inset that the tree rows, the nav's rows and the footer rows all take. The setup reminder moved out of `PluginsSidebar` into a footer row of its own (`IntegrationsSetupReminder`), passed to the frame beside the change-request dock the way the connect-your-agent pill is passed to the header; a nav that also placed the last row in the column is how the two came to disagree in the first place. Both rows decide for themselves whether they have anything to say, so the group hides itself when neither does rather than leaving a stray hairline at the bottom of every sidebar.

At 180px — the narrowest the drag handle allows — the reminder now truncates to an ellipsis with the whole line in its tooltip, and "Finish now" is never the half that gets cut: a reminder that ellipses away its own way out is a row that does nothing. The count on the CHANGE REQUESTS row keeps its place at every width, which it previously lost because a flex item's automatic minimum is its own content and the label refused to give way.
