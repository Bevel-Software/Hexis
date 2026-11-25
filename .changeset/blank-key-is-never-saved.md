---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A key that is empty or only whitespace is refused, so saving one no longer makes a tool count as set up. The three routes that save a key (a person's own key for a tool, `PUT /api/secrets/tools/:slug/vars/:var/user`; a tool's shared key, `…/admin`; a person's secret saved under a name of their own, `POST /api/secrets/static`) answer 422 "value is required" for a value that trims to nothing (spaces, tabs and newlines, a no-break space, an em space), as they already did for an empty one, and store nothing. A tool sign-in's client secret (`…/oauth/admin`) is refused the same way, with its existing 422 "clientSecret is required". A real key is saved as before. Rows saved blank before this release are left as they are.

In the app, the key and client-secret fields on a tool's Library page and on the Secrets page keep Save disabled while they hold only whitespace, as the Connect page's key fields already did.

What counts as blank is one rule, `isBlankSecret` in `@bevel-software/platform-shared`: the vault refuses by it, and the app's secrets forms (those two, the Connect page's key fields, the client secret of a managed connector's own app, and the Secrets page's sign-in form) ask it before they send a key or client secret.
