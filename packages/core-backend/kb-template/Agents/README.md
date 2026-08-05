# Agents/

`.agent` files — **role definitions for agents**, and the main way anyone
(a person's own assistant or a background pipeline) connects to the platform.
Connecting "as" an `.agent` mints exactly that agent's tool surface — e.g. the
KB's MCP config is generated per `.agent`, not from everything the identity
can read.

## Structure

```text
Agents/
├── default.agent         ← the safe floor: basic KB access only
├── developer.agent       ← an admin-authored role: everything developers get
└── <role-or-pipeline>.agent
```

One file per role or per pipeline agent. (Exact file format: TBD.)

## What an `.agent` defines

- The **target harness** (e.g. Claude Code) and model / reasoning settings.
- The **skills** and **tools** composed in — selections from `Groups/`. The execution layer compiles these into the harness's native
  plugin format and installs it.
- Permissions/allowlists, hooks, MCP servers, env vars, session defaults,
  and injected instructions (the agent's charter).
- **References** to an identity and a budget — never credentials themselves.

## Rules

- An `.agent` only **narrows** what its identity's permissions already allow —
  it never widens access. Identity remains the security boundary; `.agent`
  is configuration.
- **No secret values** in these files — secrets are referenced by vault name.
- This folder sits under access control + change requests: editing a role
  file changes the whole role's tooling, and is reviewed like any other
  change.
