---
"@bevel-software/platform-core-frontend": patch
---

The permission dropdowns in Manage access close on a click outside them and on Escape. A grantee row's verb checklist and the add-row's verb selector used to stay open until an item inside was picked or the trigger was clicked again: a click anywhere else in the dialog left the menu hanging over the list, and Escape closed the whole dialog around it. Both menus now opt into the shared `useDismissableMenu` behaviour, and an open menu registers itself as the topmost modal layer so the dialog stands down on Escape until the menu is gone. Escape hands focus back to the trigger; the trigger's own click still toggles rather than close-then-reopen. The suggestion list under the people box is untouched, since its openness is derived from what is typed rather than from a flag a click could clear.
