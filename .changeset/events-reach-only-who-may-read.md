---
'@bevel-software/platform-core-backend': patch
---

Live events reach only the people who may read what they name.

The event stream used to send every event on a branch to everyone watching it, so a person without read access to a folder still learned the names of its files, who edited them, who held their locks, and the title of every change request. Now each event is checked against its reader before it is sent: file, lock and approval events go only to people who may read the file; a new change request is announced only to people who may see it; a failed push shows git's message only to people who may read the repository root, and a fixed sentence to everyone else; an agent's tool-call summary goes only to its own person and to admins. Events replayed after a reconnect are checked the same way. People who may read a file get its events exactly as before.
