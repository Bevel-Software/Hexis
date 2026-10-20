---
'@bevel-software/platform-core-backend': patch
---

Live events reach only the people who may read what they name.

The event stream used to send every event on a branch to everyone watching it, so a person without read access to a folder still learned the names of its files, who edited them, who held their locks, and the title of every change request. Now each event is checked against its reader before it is sent: file and lock events go only to people who may read the file; approval events go only to people who may read the approved file at the request's target branch; a failed push or sync shows git's message only to people who may read the repository root and every file a conflict names, and to everyone else a fixed sentence and the conflicted files they may read; an agent's tool-call summary goes only to its own person and to admins. A new change request is still announced to everyone, but the announcement no longer carries the request's title — only its number and branches, so a person learns that a request exists and sees of it what the request itself shows them. Events replayed after a reconnect are checked the same way. People who may read a file get its events exactly as before.

The checks ask nothing of git per person: an approval is judged from the access tree at the target branch, which is cached by commit, not by reading the request's detail, which diffs the branch pair with several git subprocesses for every person connected.
