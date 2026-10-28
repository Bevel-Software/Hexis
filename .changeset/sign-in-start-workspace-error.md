---
'@bevel-software/platform-core-backend': patch
---

A sign-in start whose tool files cannot be read fails as a server error instead of answering "the owner hasn't finished setting this up". The disk walk behind a sign-in start on a declared sign-in treated a workspace it could not open as an empty scan, the catalog's rule (a listing answers "nothing released" and the next scan tries again), so the start fell back to the catalog and reported a misconfiguration that was not there. The walk now throws for a sign-in start and stays empty for the catalog.
