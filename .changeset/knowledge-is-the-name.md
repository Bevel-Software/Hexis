---
'@bevel-software/platform-core-frontend': patch
---

The connect surfaces stop saying "Hexis": the claude.ai connector is
named "Knowledge — <host>", the local MCP server's config key is
`knowledge` (beside the hosted `knowledge-base`), and the tool page
says "the local knowledge server". The npm package name and its
HEXIS_* environment variables are plumbing and keep their names.
