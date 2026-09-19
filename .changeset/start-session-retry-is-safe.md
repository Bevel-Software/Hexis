---
'@bevel-software/platform-core-backend': patch
---

`start_session` now tells the caller that retrying is safe: a call that fails created nothing, so there is no half-made session to clean up, and a retry that lands after a success just leaves two independent ids — keep using the one already passed to other tools and ignore the spare. An agent whose first call failed had no way to know either of those from the tool alone, so a transport hiccup read as an unrecoverable start.

Alongside it, a reproduction probe for that first-call failure: `pnpm --filter @bevel-software/platform-core-backend probe:first-call --base-url <deployment> --bearer <connection key>` opens fifty fresh connections, makes exactly one first call on each (never a retry, which would hide the failure), and prints the timings plus every failure with the platform's own error text. `--mode tool` makes the same call with the MCP transport removed, so a failure can be placed on one side of the transport or the other. Fifty fresh connections through the full platform — transport, proxy, catalog discovery and tool route — are now covered by a test, as are fifty concurrent calls against the tool route on its own.
