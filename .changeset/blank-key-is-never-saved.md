---
'@bevel-software/platform-core-backend': patch
---

A key that is empty or only whitespace is refused, so saving one no longer makes a tool count as set up. The three routes that save a key (a person's own key for a tool, `PUT /api/secrets/tools/:slug/vars/:var/user`; a tool's shared key, `…/admin`; a person's secret saved under a name of their own, `POST /api/secrets/static`) answer 422 "value is required" for a value that trims to nothing (spaces, tabs and newlines, a no-break space, an em space), as they already did for an empty one, and store nothing. A tool sign-in's client secret (`…/oauth/admin`) is refused the same way, with its existing 422 "clientSecret is required". A real key is saved as before. Rows saved blank before this release are left as they are.
