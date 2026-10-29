---
'@bevel-software/platform-core-backend': minor
---

The agent instructions (the MCP handshake `instructions` and `GET /api/agent/instructions`) now open with one line: call `get_agent_guide` and read the guide before anything else, because it says what this deployment is and what this connection loads. The rest of the text is unchanged; the line is part of the platform-owned `header`, ahead of the fixed header and the deployment preamble. `INSTRUCTIONS_CAP` rises to 14,600 to hold it.

`start_session` answers `connectedAs` beside `sessionId`: `{ path, name }` of the agent configuration the connection was made as, or `null` for Everything. Its description and output schema say so.
