## ADDED Requirements

### Requirement: One knowledge base's names travel as one value
The server SHALL carry what one knowledge base is called on disk and in git as a single `KbContext` value: the checkout folder name inside each workspace, the branch model (default branch and protected branches) and the folder layout (the knowledge, skills and plugins roots and the agent guide's file name). The composition root SHALL build it once from the deployment's settings and hand it to every service that needs any part of it by constructor. No server code SHALL read a process-wide binding for any of these.

#### Scenario: Two knowledge bases in one process disagree
- **WHEN** two service graphs are built in one process with different branch models and layouts
- **THEN** each graph's services answer for their own knowledge base, and building the second graph does not change what the first one reports

#### Scenario: A server file reads a live binding
- **WHEN** a file under the server packages imports `DEFAULT_BRANCH`, `PROTECTED_BRANCHES`, `KNOWLEDGE_BASE_DIR`, `SKILLS_DIR`, `PLUGINS_DIR`, `AGENTS_FILE`, `currentKbLayout`, `currentBranchModel`, `configureKbLayout`, `configureBranchModel`, `branchModelFromEnv` or `onKbLayoutApplied` from the shared package
- **THEN** lint fails naming the import, except in test files and the composition root's one permitted mirror site

### Requirement: The context is live until setup completes
A fresh deployment has no branch model until its setup screen is answered. The context SHALL be buildable in that state, SHALL report the branch model as unconfigured, and the save that completes setup SHALL apply the branch model and the folder layout to the running graph's context so the knowledge-base startup phase that runs in the same request already sees them. Services SHALL read the default branch, the protected branches and the layout at the moment they are used, never copy them at construction.

#### Scenario: Completing save applies the admin's names
- **WHEN** setup completes with folder names other than the defaults and the startup phase then runs
- **THEN** the phase scaffolds the admin's names, the context reports them afterwards, and the response asks for no restart over them

#### Scenario: A layout already in effect is not replaced
- **WHEN** the process already runs a non-default layout and a completing save carries different names
- **THEN** the context keeps the layout in effect, the response asks for a restart, and the phase runs under the layout in effect

#### Scenario: Descriptions built once follow a later layout
- **WHEN** the agent tools were registered under the defaults and a completing save applies another guide file name
- **THEN** the tool descriptions an agent lists afterwards name the applied file

### Requirement: Shared helpers are pure
Every shared helper that answers a question about the branch model or the layout SHALL take that model or layout as an argument: `isProtectedBranch(model, name)`, `protectedBranchDisplayName(model, name)`, `isPlatformFile(path, layout)`, `platformFileNames(layout)`, `reservedRootDirNames(layout)`, `renderKbLayoutPlaceholders(text, layout)`, `pluginOfPath(path, layout)`, `agentsFilePointerSentence(agentsFile)` and the rest. `resolveBranchModel(model)` and `resolveKbLayout(layout)` SHALL produce the validated, trimmed values the helpers expect. The browser SHALL keep the configured live bindings and pass `currentKbLayout()` / `currentBranchModel()` to the same helpers.

#### Scenario: Same helper, two layouts
- **WHEN** a helper is called with two different layouts in one process
- **THEN** each call answers for the layout it was given

#### Scenario: Browser configures once
- **WHEN** the browser applies the deployment's layout from `/api/config`
- **THEN** every helper the browser calls with `currentKbLayout()` answers for that layout, as before

### Requirement: Overlays that read a binding keep working
The composition root SHALL mirror the context onto the shared package's live bindings unless the port `mirrorSharedBindings` is set to false, so a single-tenant overlay that still reads a binding sees the deployment's value, including after a completing setup save.

#### Scenario: Overlay reads the default branch
- **WHEN** a single-tenant overlay reads `DEFAULT_BRANCH` after the server booted
- **THEN** it reads the deployment's default branch

#### Scenario: Multi-tenant host turns the mirror off
- **WHEN** the host builds several graphs with `mirrorSharedBindings: false`
- **THEN** the shared bindings are not written by any of them
