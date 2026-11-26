---
'@bevel-software/platform-core-backend': minor
---

The hosted MCP endpoint reads a caller's manual list and their skills in process. It read the manual list for every tool surface it built, and the skills for every `prompts/list`, every `prompts/get` and for telling a skill read from a file read in the Audit log. Each was an HTTP request to its own server (`GET /api/agent/all-tools`, `POST /api/agent/tools/list_skills` and `get_skill`) behind a 15 second limit. A busy server answered itself late, the limit fired, and the caller got the platform tools alone or an empty prompt list.

The manual list has one reader, `createManualListReader` in `modules/tool-manuals`. The `all-tools` route answers with it and the endpoint calls it, so the two cannot answer differently. `createToolManualsAgentRoutes` takes the reader as an optional last argument and makes its own from its services when it is given none.

The skills are read by the handlers the two skill routes run. `registerSkillsTools` now returns the two reads, and `createInProcessToolCaller` in `modules/tool-helpers` calls a hosted read as a function with what its route runs once its auth has passed: the caller's context, the connection's scope, then the handler. A connection the route refuses is refused in process with the same words. It takes the tool catalog too, and refuses a tool the catalog declares a write or does not list, since the route's write gates do not run in process. `createCoreServer` hands the reads to the endpoint with `McpService.readSkillsWith`.

Each read is handed the bearer the loopback request carried, and resolves it at the moment of the read with the verifier its route's auth runs (`createCallerResolver` in `modules/tool-auth`, handed `createManualTokenVerifier` for the manual list, whose route runs `manualAuth`, and `createTokenVerifier` for the skills, whose routes run `toolAuth`). So a key revoked or an account switched off after the request was admitted is refused the read, as it was at the route.

Each read in process is held to the 15 second limit the catalog revision read has (`withinLoopTime`). A stretch the event loop is held for spends one tick of it, however long. A read that never answers ends there, and the request is then served as it was when the loopback request passed its limit: the platform tools alone, not kept, or no skills.

The routes are unchanged for the local server and for scripts, which still call them. A composition that does not hand the endpoint a reader keeps reading over loopback. Nothing an agent can observe changes: tool names, arguments, answers, prompts and the agent guide are the same.

Tool discovery (`GET /api/agent/utcp`) and tool calls still go over loopback. Discovery is the last step of hx-tool-surface-is-built-without-a-loopback-call.

A minor release, not a patch: the exported `CoreServices` gains three required members, `readManualList`, `inProcessTool` and `resolveToolCaller`. Code that builds or mocks a `CoreServices` by hand must add them. `registerSkillsTools` now returns the two skill reads where it returned nothing, and `createToolManualsAgentRoutes` takes one more optional argument; neither breaks a caller.
