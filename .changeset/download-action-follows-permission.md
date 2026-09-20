---
'@bevel-software/platform-core-frontend': patch
---

The file tree's Download follows the permission it depends on. A reader without `download:` on a file picked Download from the right-click menu and got a browser alert — "Failed to download How to get started.pptx (HTTP 403): Download permission required" — because the menu offered the action to everyone and only learned the answer from the server's refusal. The file viewer's own download button has read the file's access and disabled itself with the reason for some time; the tree was the one surface still guessing.

The menu now asks for the entry's access when it opens — one request per menu open, not one per tree row — and renders Download, or a folder's Download as zip, disabled with the tooltip "You don't have download permission for this item" when the verdict says no. Disabled here is `aria-disabled`, not the native `disabled`: a disabled button stops firing the pointer events its tooltip needs and leaves the tab order, so the reason would be unreachable by exactly the two paths that most need it. Activation is refused in the handler instead, which is what stops Enter and Space on the focused item rather than only a mouse click.

While the lookup is in flight, and if it fails, the item stays enabled. A flash of disabled on every menu open would be worse than the refusal this preflight exists to avoid, and the backend's gate — unchanged — remains the authority either way.

The refusal that can still happen, when permission changes between the menu opening and the click, now appears as a dismissible inline notice under the row it is about. Not an alert: a modal popup stops the whole app to say one line, and the line names a file the sidebar is already showing.
