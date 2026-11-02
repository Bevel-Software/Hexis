---
'@bevel-software/platform-core-backend': patch
---

A tenant whose record changed while its graph was stopped is built from the record as it is now. The multi-tenant host kept the descriptor a tenant was first met with for the life of the process, so a workspace deleted and set up again under the same name on Hexis by Bevel cloud came back with the previous workspace's owner, and its new owner saw "Still being set up" (2026-10-11). A running graph keeps the config it was built from until it is stopped; the operator's edits to a record reach the tenant the same way, after its next stop.

Before the branch model is set, the admin check answers "not an admin" for everyone but the owner without trying to clone and without a warning. It used to log a stack trace at every sign-in and status poll on a fresh deployment.
