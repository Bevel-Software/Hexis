---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Knowledge pages show their images. A markdown image with a relative path (`![Approval screen](./assets/approval-screen.png)`) renders the picture from the workspace in the Knowledge view, on a skill page and in the review panel's diff. An image that fails to load shows a placeholder naming the file instead of a broken icon, and a screenshot a teammate replaces under the same name refreshes in open tabs. The convention, documented in the README and in the agent's `write_file` description, is an `assets/` folder beside the pages that use it; a Microsoft Loop export's `.assets/` folder works as it is. Change-request and version-history diffs name each image rather than showing a picture from another revision.

Raw file responses carry `Cache-Control: private, no-cache`, so a browser revalidates each image with the server and a shared cache never stores one person's authenticated file. A link written as `Some%20File.md` on a skill page now opens `Some File.md`, as it did everywhere else.
