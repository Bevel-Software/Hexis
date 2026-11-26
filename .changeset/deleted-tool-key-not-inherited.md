---
'@bevel-software/platform-core-backend': patch
---

A tool's stored keys now go with the tool when its definition leaves the catalog by any route, not only when it is deleted from its tool page. Deleting a `.tool` file, dropping a server from `mcp.json` or changing a manual's id wipes every stored value under the old name, so a later tool that reuses the name starts with no shared key. The old value is not shown as set and is not sent. A rename or move that keeps the id keeps its keys. Nothing is wiped after a scan that could not read every declaration: an unreadable folder or file, an `mcp.json` that is not a server map, or a refused `.tool` that names no manual. A refused edit that still names its manual keeps that manual's keys. Removals are noticed while the server runs. A tool removed while the server is down is not noticed after restart.
