---
"@bevel-software/platform-core-backend": minor
---

Four module entries now offer what a deployment's own modules and tool tests reached into the modules' files for: the tool-helpers entry exports `createToolHandlerFactory` beside its `ToolHandlerFactory` type, and `withBranchInput` beside `toolDef`; the tool-manuals entry exports the `VariableStatusPort` type `registerToolManualsTools` takes; the tool-auth entry exports the `InternalTokenService` class, which it offered only as a type; and the auth entry exports `readAuthCookie`, for a route reached before the session middleware, and the erasure participant contract (`IErasureParticipant`, `ErasureTarget`, `ErasureTx`) beside `IAccountErasureService`. A deployment can now import them from `modules/tool-helpers`, `modules/tool-manuals`, `modules/tool-auth` and `modules/auth`. Nothing else changes.
