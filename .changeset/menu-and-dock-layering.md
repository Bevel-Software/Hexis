---
"@bevel-software/platform-core-frontend": patch
---

Two layering fixes to floating UI. The verb menus and the people/roles autocomplete in "Manage access" were absolutely positioned inside `Dialog`'s `overflow-y-auto` body, so a menu opened on a low grantee row was clipped at the body's edge — "Can read", "Can download" and "Remove access" were cut off and unreachable. They now render `fixed`, anchored to the trigger's measured rect and flipping above it when there is no room below; not portaled, so they stay inside the dialog's focus trap and remain Tab-reachable. Separately, the change-request dock dropped from `z-55` to `z-30`: as ambient page furniture it was outranking the `z-40` anchored-dropdown layer and the `z-50` modal layer, and was painting over the open profile menu.
