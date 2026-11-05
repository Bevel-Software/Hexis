---
"@bevel-software/platform-core-backend": minor
---

An idle kept-alive connection outlives a reverse proxy's pool: `applyHttpServerTimeouts(server)` sets the server's `keepAliveTimeout` to `HTTP_KEEP_ALIVE_TIMEOUT_MS` (120 seconds, up from Node's 5), so responses advertise `Keep-Alive: timeout=120` and a proxy pooling connections to the server (Traefik 90 s, nginx and AWS ALB 60 s) never reuses a socket the server closed first. A shell calls it on the server its `app.listen` returns; `apps/server` does at both boot shapes. The headers and request timeouts keep Node's defaults.
