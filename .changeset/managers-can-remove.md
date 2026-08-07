---
'@bevel-software/platform-core-frontend': patch
---

Group managers can remove skills and tools from their group. Each card on
a group page grows a quiet remove control, visible only to the people who
run the group (the same canWrite that answers join requests), behind a
confirm that says who loses what. Your personal space gets the same
control on everything in it. The delete rides the ordinary workspace
machinery, so the per-path access gate enforces for real what the UI only
gates cosmetically; the content survives in git history.
