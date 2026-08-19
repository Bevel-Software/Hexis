---
'@bevel-software/platform-core-backend': minor
---

`DOMAIN` now derives the deployment's public shape. Setting it declares "the
bundled Caddy `https` profile fronts this deployment": `PUBLIC_BACKEND_URL`
and `PUBLIC_FRONTEND_URL` default to `https://<DOMAIN>` and `TRUST_PROXY` to
`1` (one proxy hop). Explicit values for any of the three always win. With no
`DOMAIN` and no explicit `PUBLIC_FRONTEND_URL`, the frontend origin now
defaults to the backend origin in production (the backend serves the SPA;
development keeps Vite's `:5173`).
