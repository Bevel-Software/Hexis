---
'@bevel-software/platform-core-backend': patch
---

A deployment whose git host cannot be reached at start-up now comes up instead of refusing to. Previously the knowledge-base start-up phase stopped the boot on an unreachable remote — a host that is down, a name that does not resolve, a token that was rotated — and it did so before the login and setup screens were mounted, so the one thing an operator needed in order to fix a rotated token was the thing the failure took away. The container restarted in a loop until the host came back or someone set the break-glass variable by hand.

Now that one failure is told apart from every other. The deployment starts gated and unmaintained: the setup screen shows why, saving it retries, and the server keeps trying on its own with a growing wait of up to ten minutes, opening the gate the moment a run succeeds. No session can hold a working clone while the gate is shut, which is what makes that background retry safe. A token the host rejects is the one such failure that is not re-dialed on a timer: the host answers the same until the token changes, and re-dialing with a dead one is what gets it rate-limited or locked, so that boot comes up gated with the rejection shown and is retried by the setup save that changes the token. Every other failure of the start-up phase still stops the boot, because those say the template or a step would write something wrong, and asking again would not change that.

`KB_SAFE_BOOT` is unchanged and still the break-glass for the other failures. Nothing new to configure.
