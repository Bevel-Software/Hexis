---
"@bevel-software/platform-core-backend": minor
---

Two module entries now offer what a deployment's own tool tests and wiring construct: the tool-helpers entry exports `createToolHandlerFactory` beside its `ToolHandlerFactory` type, and the tool-auth entry exports the `InternalTokenService` class, which it offered only as a type. A deployment that built its tool handlers or minted internal tokens in its tests reached into the modules' files for them; it can now import them from `modules/tool-helpers` and `modules/tool-auth`. Nothing else changes.
