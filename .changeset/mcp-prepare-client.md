---
"@bevel-software/platform-core-backend": minor
---

A tool can send a file. A `.tool` http call whose body input is declared `format: file-path` sends the bytes of the file the call names, read as the caller: a knowledge-base file their access lets them read on the default branch, or a staged file of theirs (`__tmp__/…`). A file they cannot read, or that is not there, refuses the call before anything is sent. The MCP endpoint does this for every caller (`McpProxyOptions.readFileBody`, set by `createCoreServices`), after the argument checks, which still see the path as the agent wrote it. `modules/code-mode` exports the swap (`installFileBodies`, `fileBodyReader`, `FileBodyError`), so a distribution's own in-process agent installs the same on its client. The agent guide's `tool-manuals` section says how to declare such a tool.
