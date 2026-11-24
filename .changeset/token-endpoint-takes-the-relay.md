---
'@bevel-software/platform-core-backend': patch
---

The MCP token endpoint (`POST /token`) allows 1,000 requests per client address per 15 minutes (was the MCP SDK's default of 50), so the Bevel for Copilot relay, which brings every Copilot user's sign-in and refresh from one address, is not refused with 429. The authorization and registration endpoints keep the SDK's limits, and the client address is read as before (`TRUST_PROXY`).
