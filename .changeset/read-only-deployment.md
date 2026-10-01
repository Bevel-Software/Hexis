---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

A host can make a deployment read-only.

The new `ports.writeAccess` (`IWriteAccess`) says whether the deployment may be changed right now. While it says no, everyone can still sign in and read, but every change is refused with a 403 carrying `code: 'workspace_read_only'` and the port's message. The app shows that message in a banner. This is for a host that sells seats: a workspace with more accounts switched on than its plan allows is read-only until an admin brings the number down or buys seats.

The gate sits in front of every route. Only these mutating routes stay open:
- signing in;
- agent connections and their keys;
- account administration, which is how an admin brings the number of people down;
- deployment setup, tool secrets and `/api/sync`;
- the POST routes that change nothing, such as permission queries, previews, heartbeats and fetching remotes.

Every tool call passes the HTTP gate, and the tool layer refuses write tools on its own. A host lists its own routes that must stay usable, such as buying seats, in `alwaysWritablePaths`. A port that throws is treated as writable. Background work (the commit worker, sweeps, directory sync) is not gated: it finishes what was accepted before the deployment went read-only.

Core fills no port, so a core deployment is always writable.

New:
- route `GET /api/write-access`;
- exported from the package root: `alwaysWritable`, `READ_ONLY_CODE`, `IWriteAccess` and `WriteAccessVerdict`;
- `CoreServices.writeAccess`.

Changed:
- `createToolHandlerFactory` takes an optional `IWriteAccess`.
