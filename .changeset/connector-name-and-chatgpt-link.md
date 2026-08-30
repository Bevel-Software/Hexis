---
'@bevel-software/platform-core-frontend': patch
---

The MCP server is now called "Skills, Tools and Knowledge" everywhere a person connects an agent — the welcome page, the External agent access page and every connection snippet — instead of just "Knowledge". In claude.ai's connector list it appears as `Skills, Tools and Knowledge — <host>`; in config files and `claude mcp add` it is the key `skills-tools-knowledge`, replacing both the hosted `knowledge-base` and the local `knowledge` keys (a client that added the server by hand under an old key keeps working, and gets a second entry if the new snippet is pasted). An "Add to ChatGPT" button now sits beside "Add to Claude": ChatGPT has no prefill link, so it opens ChatGPT's connector settings and the name and URL to paste are shown right beside it.
