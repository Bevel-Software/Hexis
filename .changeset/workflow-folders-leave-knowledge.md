---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-core-backend': patch
---

The execution root is `Workflows/`, and an app may host root folders.

`PIPELINES_DIR = 'Pipelines'` is renamed `WORKFLOWS_DIR = 'Workflows'`. It is one of the reserved root names (`reservedRootDirNames`, and the reserved-name refusal, which now lists `Data, Agents, Workflows`), and the explorer renders a `Workflows/` folder as its own section when present. `Pipelines` is no longer a name core knows: it is not reserved and not a section, so a `Pipelines/` folder is folded into Knowledge like any other top-level folder, unless an app claims it. A consumer importing `PIPELINES_DIR` imports `WORKFLOWS_DIR` instead.

`AppDef` gains `roots?: string[]`: the top-level folders the app hosts, by name in any case. A claimed root leaves the Knowledge explorer, and a file URL under it (`/workspace/<branch>/<kbDir>/<root>/…`, unchanged, as `kbFileUrl` builds it) renders the claiming app's `element` with the switcher on that app; an id URL that resolves to such a file is replaced by its path URL. Two apps claiming one root, or an app claiming one of core's own roots (the layout's knowledge, skills and plugins folders), throw when the shell mounts. The registry exports the one reading of a claim: `rootClaims(apps)` (root to app id, throwing on a refused claim), `appClaimingRoot(claims, root)`, `appHostingPath(claims, workspacePath, kbDirName)` (a path outside the KB clone is hosted by no app once `kbDirName` is known; before bootstrap, when it is null, the first segment is not checked, so a pasted link opens in its app on the first render) and `useRootClaims()`. `KnowledgeSurface` is exported, and `<KnowledgeSurface roots={[…]} />` is the folder surface an app mounts for its roots: the explorer limited to them, with the Knowledge app's viewer, tab strip, renderers, file operations and proposed-file state. With no root claimed, nothing changes.

`core-backend`: the template step's comments and the agent guide's directory section say `Workflows`; the access grammar's examples use the `.workflow` extension.
