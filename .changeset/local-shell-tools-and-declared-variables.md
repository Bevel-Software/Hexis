---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Shell tools, resolved where they run — and an access grammar an overlay can extend.

**`@utcp/cli`, registered for parsing only.** A `.tool` whose tools shell out is
how a local runtime gets a git surface without an agent ever holding a token.
The platform has to understand those files — scan, validate, list, serve the
manual body to the server that will run it — so the `cli` serializer is
registered here. Its executor is not: `@utcp/cli`'s module-level `register()`
installs both, and the `CliCommunicationProtocol` is removed from the SDK
registry immediately after the import that added it. The hosted process
therefore cannot dispatch a shell command at all. Forcing `remote: false` on any
manual containing a cli template is the second, independent mechanism, and a
declared `remote: true` beside one is refused rather than quietly corrected.

**Local tools stop depending on the machine they run on.** A new route resolves
the variables a `remote: false` `.tool` declares, and hexis-mcp carries a UTCP
variable loader that uses it. Previously every person running a local tool
hand-placed its credentials in their own MCP client config, and a rotation had
to be repeated everywhere it had been copied. The request names the MANUAL,
never a variable: the server re-reads the `.tool` and resolves exactly what it
declares, so the knowledge base is the allowlist and no caller can widen it.
Values are bound to that manual's UTCP namespace, so one local tool cannot reach
another's secret, and nothing is returned to a caller — it is substituted into a
tool invocation and goes no further. `process.env` remains UTCP's last tier, so
existing setups keep working.

**`registerAccessFrontmatterExtensions`.** The set of files whose own
frontmatter carries access verbs is `['.md', '.tool']` plus whatever an overlay
registers at boot. Overlays that ship their own whole-document configuration —
files that grant capability by being edited, as a `.tool` does — keep per-file
governance on them without core knowing those file kinds exist. Additive only:
an extension cannot be removed, because removing one would silently drop grants
already being enforced.

`list_local_tools` now also returns each manual's `slug`, which is how the
variable route is addressed.
