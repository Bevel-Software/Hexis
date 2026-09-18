---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A tool proposed in an open change request now shows in the library as a Proposed card, the way a proposed skill already did. Ask the agent for a tool and a change request opens; until it merged, the tools UI showed nothing at all — not to the person who asked, and not to the person who had to approve it — because the tool catalog is built from the default branch and the declaration was not on it yet.

`GET /api/tools/pending` is the missing half of that catalog. It walks the OPEN change requests and reports the ones that ADD a tool: a `.tool` UTCP manual anywhere under the plugins root, or a server added to a plugin's `mcp.json`. Each entry carries the tool's name, the plugin it targets, the declaration's path and the change request's number and branch. A declaration whose UTCP name the default branch already serves is an edit of a live tool, not a proposal, and is left to the tool's own page.

Who may see one is exactly who may see a proposed skill: its author, and whoever could approve it — `canWrite` on the very path the request would create, resolved on the default branch, so the verdict inherits from the plugin folder that is the plugin's admin. Somebody who cannot see the change request sees no card. That rule and the read-at-the-branch mechanics now live in one place shared by both surfaces, so the two cannot drift on the part that matters most.

In the library the proposal is a card in its plugin's Tools band, dashed and badged `In review`, saying whether it is waiting on you or on somebody else. It links to the change request and opens nothing else: there is no tool page to open, and a page would start probing a connection for a file nobody has approved. It is never counted as an integration needing setup — a proposal is a review concern, not a credential to fill in. Once the request merges, closes or is cancelled the backend stops listing it, so the next load shows the real tool or nothing at all.
