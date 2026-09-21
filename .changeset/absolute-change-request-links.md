---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-shared': patch
---

A change request's `url` is now an absolute link a person can open, built from the configured public frontend address (`PUBLIC_FRONTEND_URL`, else `https://<DOMAIN>`, else — in production only, where the backend serves the frontend — `PUBLIC_BACKEND_URL`), path prefix included. Without one it stays the relative path and carries `urlNote: "Set PUBLIC_FRONTEND_URL to get absolute links."`. `post_change_request_comment` also returns the change request's `{ number, url }`.
