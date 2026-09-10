---
"@bevel-software/platform-core-frontend": patch
---

The "Hexis x.y.z is available" banner that admins saw at the top of the app is gone, along with the frontend module that fetched it. The backend's `GET /api/update-check` endpoint and its `UPDATE_CHECK` setting are untouched, so nothing else that reads them changes.
