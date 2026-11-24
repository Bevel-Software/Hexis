---
"@bevel-software/platform-core-backend": minor
---

A deployment can now import what its own modules and tool tests reached into core-backend's files for. The package entry exports `createToolHandlerFactory` and the `InternalTokenService` class, which a deployment wires to build and test its own platform tools, as the composition root does; the module entries keep offering only their types. The tool-helpers entry exports `withBranchInput` beside `toolDef`; the tool-manuals entry exports the `VariableStatusPort` type `registerToolManualsTools` takes; and the auth entry exports `sessionTokenOf`, the session token a request carries (its Bearer header, else auth's cookie) read by the session middleware's own rule, for a route mounted before that middleware, and the erasure participant contract (`IErasureParticipant`, `ErasureTarget`, `ErasureTx`) beside `IAccountErasureService`. Nothing else changes.
