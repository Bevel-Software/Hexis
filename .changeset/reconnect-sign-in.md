---
'@bevel-software/platform-core-frontend': patch
---

A connected sign-in on a tool's page now has a **Reconnect** button beside its Connected chip. Providers can widen what a token needs after the fact (HubSpot's MCP tools answer `REQUIRES_REAUTHORIZATION` until the user consents again) or revoke a grant, and until now the tool page offered no way back into consent while the row still read Connected — only the Secrets page did.
