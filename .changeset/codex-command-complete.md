---
'@bevel-software/platform-core-frontend': patch
---

The Codex command on External agent access is now a complete four-line block: add the marketplace, `codex plugin add skills-and-knowledge@hexis`, `codex mcp login hexis`, and a `codex exec` line that asks Codex to call a Hexis tool. Adding a marketplace installs nothing in Codex, and the compiled plugin's server entry carries no credentials, so before this a Codex user saw Hexis configured with no tools and had to find the login command in an error message. The page and the connection-keys dialog say why the login line is there. The forms were checked against Codex CLI 0.154.0; Codex uses `skills-and-knowledge` because its catalogue does not list the `hexis-all` bundle. The Claude Code and skills CLI commands are unchanged.
