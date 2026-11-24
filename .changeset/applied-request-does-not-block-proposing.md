---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A person who opened their own applied change request can propose and upload from the app again. Opening it reads the request's suggestions branch, which the apply removed, and `GET /api/workspace` answered that 410 without a caching rule. Chromium kept it and answered the next proposal's read of the same address from its cache, after the proposal had created the branch again, so later Sends in that browser showed "HTTP 410". The route now answers `Cache-Control: no-store`, and the app reads it without the browser cache, so a 410 a browser stored before this release is not read back either. A proposal whose suggestions branch cannot be opened now says that nothing was sent and to try again in a moment, instead of "HTTP 410".
