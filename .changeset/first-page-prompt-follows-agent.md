---
'@bevel-software/platform-core-frontend': minor
---

"Write your first page" leads with the way in that suits the agent you connected.

A ChatGPT connection gets "Ask ChatGPT to write it", with Open in Claude and Copy prompt quiet beside it; a Claude connection (claude.ai or Claude Desktop with the hosted address) keeps "Ask Claude to write it". Every other agent — Claude Code, Cursor, any agent on the local server, a connection key's label, or a name the app does not know — gets Copy prompt as the main button and "Paste it into <agent>." under it, with both web links quiet, because no link opens those agents and a web chat would not reach the knowledge base. The choice is read from the connection check's `client` by `firstPageRoute` in `first-page-prompt.ts`.
