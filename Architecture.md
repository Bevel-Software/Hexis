# Architecture Ground Rules

## 1. Modular Domain-Driven Design

The codebase is organized by **domain**, not by technical layer. Each domain module owns its models, interfaces, and implementations.

```
packages/
  shared/            # cross-cutting contracts (IWorkspaceService, git/auth/workflow types)
  core-backend/
    src/modules/
      workspace/     # branches, files, the file readers behind read_file/grep
      access/        # roles, groups, access rules
      auth/          # sessions, OIDC, rate limiting
      mcp/           # the agent tool surface
      skills/        # the skill catalog
      ...
  core-frontend/     # the web app
  mcp-core/          # the transport-agnostic MCP surface, shared by the hosted proxy and hexis-mcp
  hexis-mcp/         # the local MCP server
```
(Abridged — `packages/core-backend/src/modules/` holds one folder per domain.)

A domain module **never** reaches into another module's internals. All cross-module communication goes through exported interfaces. (This is the rule new code is held to; the tree is not there yet everywhere — the access module still takes the concrete `WorkspaceService` from the workspace module, and moving it onto `IWorkspaceService` is an open migration, not a reason to add another such import.)

## 2. Contracts First — Interfaces Over Implementations

All business logic is defined as **interfaces** before any implementation is written.

```ts
// Define the contract (packages/core-backend/src/modules/workspace/file-readers/file-reader.ts) —
// an EXCERPT: the real interface also names the file kind, whether the
// text is editable, and the edit and stat hooks. Read the file before
// implementing it; `implements FileReader` on this excerpt does not compile.
interface FileReader {
  readonly extensions: readonly string[];
  read(bytes: Buffer, path: string): Promise<ReadResult>;
  greppableText?(bytes: Buffer, path: string): Promise<string | null>;
}

// Implement separately, one class per kind of file
class DocumentReader implements FileReader { ... }
class ImageReader implements FileReader { ... }
```

- Every service, repository, and use-case exposes an interface (`IWorkspaceService`, `IAccessControl`, `FileReader`).
- Consumers depend on the interface, never the concrete class.
- This applies to per-format capabilities too: `read_file` and `grep` dispatch through `FileReaderRegistry` and never name a format; adding one is a new `FileReader`, not a new branch in the tools.

## 3. Data Classes — Controlled Access

Domain data is encapsulated in **data classes** with private fields. Public methods return data in the format the caller actually needs — no leaking internal structure.

```ts
// modules/auth/rate-limit.ts
class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  // Answers the caller's question — "is this attempt allowed?" — not the map
  consume(key: string): boolean { ... }

  // A successful login clears the window; nobody edits `hits` from outside
  reset(key: string): void { ... }
}
```

- Fields are **private** by default.
- Expose purpose-specific accessors, not generic getters.
- If a caller needs data in a particular shape, the data class provides a method for that shape.

## 4. Dependency Injection

All dependencies are **injected**, never instantiated inline.

```ts
// Good — dependencies are injected (packages/core-backend/src/modules/access/access-control.service.ts).
// Type them as the CONTRACT: `IWorkspaceService`, not the class. (The real
// service still says `WorkspaceService` here — see the note under §1 — and
// that is the exception to migrate, not the shape to copy.)
class AccessControlService implements IAccessControl {
  constructor(
    private readonly workspaceService: IWorkspaceService,
    private readonly kbDirName: string,
    private readonly disk: ITreeWalker,
  ) {}
}

// Bad — hardcoded dependency
class AccessControlService {
  private workspaceService = new WorkspaceService(...);
}
```

- Use constructor injection as the default.
- A composition root wires everything together at app startup: `createCoreServices()` in `packages/core-backend/src/core/create-core-services.ts` constructs every service once and hands each its collaborators.
- This makes every component testable in isolation — swap real services for test doubles via the same interface.

## 5. Summary of Non-Negotiables

| Rule | Rationale |
|------|-----------|
| Organize by domain, not by layer | Keeps related logic cohesive and modules independently evolvable |
| Define interfaces before implementations | Decouples consumers from providers; enables substitution |
| Private fields + purpose-built accessors | Prevents callers from depending on internal data shapes |
| Inject all dependencies | Makes code testable, swappable, and explicit about what it needs |
| No cross-domain internal imports | Enforces module boundaries; domains communicate through contracts |
