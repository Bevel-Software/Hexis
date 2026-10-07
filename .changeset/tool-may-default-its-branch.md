---
'@bevel-software/platform-core-backend': minor
---

A tool declares how it treats its branch, and the tool handler resolves the branch before the tool runs — for the platform's tools and a deployment's alike.

- `toolDef` takes `branch: 'required' | 'defaults-to-default-branch'`. A tool whose inputs require `branch` is `required` without saying so; a tool with no `branch` takes none. Both are exported from the tool helpers with `BRANCH_INPUT` and `DEFAULTED_BRANCH_INPUT`, and documented there.
- `required`: a call without a branch, or with an empty or non-string one, is answered 400 `branch-required` with the sentence `read_file` gives, and the tool does not run. This now holds for a deployment's tools too, with no guard in the tool.
- `defaults-to-default-branch`: a call without a branch runs on the deployment's default branch (read at call time, so a rename in the settings applies to the next call), its input schema shows `branch` as optional and says so, and an object answer without a `branch` field gets one naming the branch used. An empty or non-string branch is still refused. A writing tool declaring it fails at startup with a message naming the tool.
- A branch that is given and does not exist is answered 404 `branch-not-found`, naming it, before the tool runs, and no workspace is created for it.
- The tool reads the resolved branch from `ctx.branch` (and `args.branch`, which carries the same value); a tool that takes no branch is handed none.
- Every platform tool stays `required`; the per-family guards in the workspace and workflow tools are gone in favour of the handler's.

A deployment's tool that reads `args.branch` keeps working unchanged. One whose inputs do not require `branch` gets no refusal until it declares one.
