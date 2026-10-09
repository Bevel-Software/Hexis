---
'@bevel-software/platform-core-backend': patch
---

A git call the repository host refuses a credential heals itself, and a deployment that cannot ask for one says so.

Every git call the server makes now carries the credential helper on the call itself, so a clone whose config lost its helper (unstamped while the deployment briefly had no token, or created by a build that authenticated only its own clone) still authenticates; the stamped helper in the clone's config is no longer what the server's own calls depend on. When git is refused a credential anyway — "could not read Username", or "Authentication failed" for a token the host threw out — the server tells the credential provider, which drops the refused token and asks the host for another past whatever it remembers about a recent failure, and runs the command once more with the new one. Only with a new one: a token that could not be replaced is not offered again, and a credential the caller supplied for the call is the caller's to judge. One retry: both refusals are the host settling the credential before it acts on the command, so a command refused this way changed nothing on the host, and a second refusal with a token just issued is the host's answer.

A GitHub App deployment whose app settings are incomplete used to run every git call without a credential and log nothing about it. It now logs which settings are empty, once per state rather than before every call.
