---
'@bevel-software/platform-core-frontend': patch
---

A change request's link opens the request.

The address every agent hands a person for a change request — `https://<deployment>/change-requests/<number>`, from `open_change_request`, the change-request read tools and every summary's `url` — matched no route in the app: it landed on the knowledge base with nothing open and no word why. The app now opens the request at that address, in the change-request view, on its first changed file; closing it or applying it goes to the knowledge base. A number that is not one, a request that is not there, and one the viewer may not see all answer with the same sentence, so the address never says which.
