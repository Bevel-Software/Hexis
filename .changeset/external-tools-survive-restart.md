---
'@bevel-software/platform-core-backend': minor
---

`list_tool_setup` takes an optional `branch` and returns `onBranchOnly`: the tools declared on that draft that the default-branch catalog does not serve yet, each with its path, plus a `note` saying they go live once the draft is merged. The in-app agent defaults to its focused branch. The tool description and the knowledge-base agent guide now state that tools are served from the default branch only. A new test rebuilds the catalog in a fresh process over the same files and vault rows to check that both kinds of OAuth server (auto-registered and owner-declared) stay listed and signed in after a restart, with no new client registration.
