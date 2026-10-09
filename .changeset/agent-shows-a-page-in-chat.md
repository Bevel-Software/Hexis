---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/hexis-mcp': minor
---

An agent can show a knowledge-base page inside the chat, and the embed that renders it is part of Hexis.

- A new MCP tool `open_page` takes a path and an optional heading and answers the page's text exactly as `read_file` does — the same read hook, the same access gate, the same refusal for a path you may not read or one that is not there — plus the embed address, the page's address in the app, the path, and the branch it rendered (always the default branch). It carries MCP Apps metadata naming a `ui://` view, which the endpoint serves over `resources/read` with the deployment's own public origin as the only frameable one. `read_file` is untouched.
- The `/embed` page itself moves into Hexis, available on every deployment: a short-lived, pseudonymous token scoped to one file and one identity, rendering the page with **the app's own renderer for its type** — markdown, HTML pages, documents and images included. A viewer who may write the file on the default branch gets Edit, saving under the platform's lock exactly as the file page does; a viewer who may not gets Propose changes, which lands a change request authored by them. Nobody is shown a "no access" notice where a control belongs.
- Any host may frame the embed page, which is what makes it work in every chat host's sandbox without a setting per host; the security rests on the token, so **every embed data route accepts the token and nothing else** — a request carrying a valid session and no token is refused. The account-link page, which acts under the signed-in session, refuses every framing ancestor.
- Links inside the embedded view open the app in a new tab through the host, and never navigate the embed; external links leave the same way, through the same scheme allowlist the app applies.
- The local server `hexis-mcp` forwards the tool's view metadata and serves the `ui://` view it reads from the deployment, so a host connected through it renders the page too. A deployment that serves no app leaves every tool exactly as it was.
- On a deployment reached over plain http there is no embedded view — no host's https sandbox can frame one — and `open_page` answers the text and the app address and says so.
- The Atlassian connector's mint is unchanged: shared secret, account id, reference. Migration `0017_atlassian_account_links.sql` ADOPTS the table an enterprise database already has rather than recreating it, so every account link survives the upgrade and nobody re-links.
- The image carries the view: `mcp-app/` joins `migrations/`, `kb-template/` and `agent-guide/` in the Dockerfile's runtime stage, and `packaged-assets-ship.test.ts` now checks all four. Without it an image advertised an app whose view could not be read, and the page-in-chat degraded to text on every real build.
- `EMBED_SHARED_SECRET` is documented and passed through by the compose files, so the Atlassian mint can actually be configured on a shipped deployment.
- `open_page` answers `structuredContent` beside its text, on the hosted endpoint and through `hexis-mcp` alike — the view reads the embed address from there — and the view now speaks the handshake a host requires (`appInfo`, `appCapabilities`, `ui/notifications/initialized`) and reads the tool result as the CallToolResult the host sends. Other tools' results are unchanged.
- An embedded save writes only under a lock the viewer holds: a frame that was hidden, lost its lock and came back to find somebody else editing is refused rather than writing over them, and is told who has it. A lock heartbeat re-checks write access.
- Linking an Atlassian account now asks the signed-in person to confirm, naming both accounts, so a crafted link cannot bind a stranger's account to whoever follows it.
- The embed builds its paths from the resolved knowledge-base folder name (a deployment on the default name or one named in setup had none), reads an extensionless root file such as `readme` as the file it is, refuses a separator spelled `%2F`, sends no cookies on its token-only calls, forbids caching the loaded page, and its view mint stays open on a read-only deployment.
