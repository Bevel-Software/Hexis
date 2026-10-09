---
'@bevel-software/platform-core-frontend': patch
---

"Connect your tools" is a Skills & Tools page at `/skills-and-tools/connect`, inside the Skills & Tools layout: the same top bar as the rest of Skills & Tools (sidebar toggle, "Hexis by Bevel", Skills & Tools selected) and the Skills & Tools sidebar beside it, in plain and agent-connect mode alike. `/connect` stays as a permanent redirect that keeps its query and fragment and replaces the history entry, so every address the server hands out (MCP consent, the claude.ai hand-off, tool sign-in returns) still lands on the page. In-app links open the new address directly, and the page's own "‹ Skills & tools" link is gone.

A tool sign-in that comes back refused (`#error=…`) now shows its reason on the page; the page's first load used to clear it before it was seen.
