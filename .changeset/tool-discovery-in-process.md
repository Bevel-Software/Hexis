---
'@bevel-software/platform-core-backend': minor
---

The hosted MCP endpoint discovers the tools of the manuals this server hosts in process. To build a caller's tool surface it asked its own server for the platform's tools (`GET /api/agent/utcp`) and for each inline `.tool`'s tools (`GET /api/tools/:slug/manual`), with HTTP requests behind a 10 second limit. A busy server answered itself late and the caller was told `Bevel tool discovery failed: timeout of 10000ms exceeded`. This is the last step of hx-tool-surface-is-built-without-a-loopback-call: building a surface now sends this server no request.

Each manual has one reader, which its route answers with and the endpoint calls: `createExternalManualReader` in `modules/tool-registry` and `createInlineManualReader` in `modules/tool-manuals`. The endpoint reads the manual first and hands it to the tool client through the `direct-call` protocol, which discovers a manual by calling a function. The function is registered once for each server graph, by the composition root (`ManualInHand` in `modules/mcp`, handed to the endpoint as `manualInHand`), under a name of its own, and answers the manual the current registration carries. A composition that hands the endpoint the readers but no `manualInHand` discovers over loopback. The client keeps the tools that use the manual's own protocol, as it did over HTTP, so a hosted manual cannot bring in a tool that runs as a function in this process.

Each read is handed the bearer the discovery request carried and resolves it with the verifier the two routes' auth (`manualAuth`) runs, `createManualTokenVerifier` in `modules/tool-auth`, so a key revoked after its request was admitted discovers nothing, as before. Each read is held to the 15 second limit the other in-process reads have (`withinLoopTime`), where the HTTP discovery had 10 seconds on the clock. That limit is spent in ticks: a stretch the event loop is held for spends one tick, however long, and while the loop keeps turning the limit runs on the clock. A read that fails, is refused or exceeds the limit is a discovery that failed, worded as it was.

Tool calls are unchanged: a discovered tool is still called at its route, with the bearer of the request that calls it. The two routes are unchanged for the local server and for scripts. A third-party `.tool` is discovered at its own address as before. A composition that hands the endpoint no reader keeps discovering over loopback. Nothing an agent can observe changes.

A minor release for the new exports. `CoreServices` gains no member in this step.
