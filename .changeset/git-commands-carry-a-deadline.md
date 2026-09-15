---
'@bevel-software/platform-core-backend': patch
---

Every git command now runs under a deadline, and a command that outlives it is killed along with everything it spawned. Four of the six places that run git had no time limit at all, the busiest of them included, so a remote that accepted a connection and then stopped talking left git waiting indefinitely. That is not one stalled request: the call holds the workspace lock that serializes every other operation on the same clone, and because the commit queue drains one workspace at a time, a single unresponsive host could stop the whole deployment committing. Files still saved to disk and still appeared in the app; git history just quietly stopped moving.

Killing git alone would not have fixed it, which is also why the two sites that did have a limit were not as protected as they looked. For anything touching a remote, git is a launcher — it spawns a transport helper and hands it the same output pipes, and Node considers a command finished when those pipes close rather than when git itself exits. Signalling only git left the helper holding the pipes and the wait running on the helper's own timeout: measured at twenty-one seconds against a one-second deadline. The whole process tree is stopped now, so the deadline bounds the wait it is supposed to bound.

`GIT_TIMEOUT_MS` sets the ceiling, defaulting to two minutes. It is deliberately generous: its job is to catch the case where git will never return, not to cut short work that is legitimately slow, and a first clone of a large knowledge base over a slow link is legitimately slow. Deployments whose git host is slower than that can raise it.

A timed-out command now reports itself as a timeout rather than as an ordinary failure. This matters for code that reads git's exit codes as answers — "there is no such ref", "there is nothing to commit" — which would otherwise draw a conclusion about the repository from what is really a statement about the network.
